'use strict';

const { fail } = require('./errors');
const chatml = require('./chatml');
const { positive } = require('./context');
const { formOf, readResponse } = require('./client');
const readout = require('./readout');
const { RAW_SAMPLING, probsToEntries, guardVram } = require('./backends/node-llama-cpp');

function validateNativeContext(context) {
	if (context.tools?.length || context.messages.some(m => m.tool_calls || !['system', 'user', 'assistant'].includes(m.role)))
		throw fail('NOTJEV_NATIVE_CONTEXT_UNSUPPORTED', 'Native context currently supports system/user/assistant text; use HTTP for tool histories');
	if (context.messages.some(m => typeof m.content !== 'string'))
		throw fail('NOTJEV_NATIVE_VISION_UNSUPPORTED', 'node-llama-cpp does not expose image evaluation here; use a multimodal HTTP engine with mmproj');
	if (context.templateKwargs && Object.keys(context.templateKwargs).some(k => k !== 'enable_thinking')
		|| context.templateKwargs?.enable_thinking === true)
		throw fail('NOTJEV_NATIVE_TEMPLATE_UNSUPPORTED', 'Native readout requires thinking off and its model chat wrapper');
}

async function loadNative(options) {
	let nlc;
	try { nlc = await import('node-llama-cpp'); }
	catch (e) { throw fail('NODE_LLAMA_CPP_MISSING', 'Install optional peer node-llama-cpp to use the native backend', { cause: e }); }
	let llama, model, context;
	try {
		llama = await nlc.getLlama({ gpu: options.gpu === undefined ? 'auto' : options.gpu,
			build: 'never', progressLogs: false, logger: (level, message) => process.stderr.write('[llama:' + level + '] ' + message + '\n') });
		const before = (await llama.getVramState()).used;
		model = await llama.loadModel({ modelPath: options.modelPath, gpuLayers: options.gpu === false ? 0 : 'auto' });
		const after = (await llama.getVramState()).used;
		guardVram({ requireGpu: !!options.requireGpu, before, after, gpuLayers: model.gpuLayers });
		context = await model.createContext({ contextSize: options.contextSize || 4096, sequences: 1 });
		const seq = context.getSequence({ checkpoints: { max: 2, interval: false, maxMemory: 256 * 1024 * 1024 } });
		/* No node-llama-cpp chat wrapper here: with the model's embedded Jinja template the trailing
		 * model turn is cut at the THOUGHT prefix (think block open) whatever `reasoning`/`enable_thinking`
		 * say — the readout then sits on reasoning tokens, not on the answer. The core renders the
		 * thinking-off ChatML itself (validated in vivo 21/09), so we do the same, byte for byte. */
		function render(messages, questionText) {
			const turns = messages.map(m => ({ role: m.role, content: String(m.content) }));
			const base = messages.length ? chatml.render(turns) : '';
			turns.push({ role: 'user', content: questionText }, { role: 'assistant', content: null });
			const text = chatml.render(turns, { thinkingOff: true });
			return { ids: Array.from(model.tokenize(text, true)), base: Array.from(model.tokenize(base, true)), text };
		}
		return { seq, model, render,
			info: { gpu: llama.gpu, gpuLayers: model.gpuLayers, render: 'chatml(thinkingOff)', needsCheckpoints: seq.needsCheckpoints },
			async dispose() { await context.dispose(); await model.dispose(); await llama.dispose(); } };
	} catch (e) {
		await context?.dispose(); await model?.dispose(); await llama?.dispose(); throw e;
	}
}

/** One resident model, one exclusively queued sequence, bounded in-memory checkpoints. */
async function createNativeContextBackend(options = {}) {
	if (options.mmproj) throw fail('NOTJEV_NATIVE_VISION_UNSUPPORTED', 'Use --llama-server with --mmproj for vision; node-llama-cpp exposes text inference only here');
	const runtime = await (options.load || loadNative)(options);
	const { seq, model, render } = runtime;
	let tail = Promise.resolve(), closed = false, closePromise;
	const chunkSize = positive(options.chunkSize, 256, 'chunkSize');
	async function evaluate(tokens, signal) {
		for (let i = 0; i < tokens.length; i += chunkSize) {
			signal?.throwIfAborted();
			await seq.evaluateWithoutGeneratingNewTokens(tokens.slice(i, i + chunkSize));
		}
	}
	async function decide({ context, question, signal }) {
		signal?.throwIfAborted();
		validateNativeContext(context);
		const form = formOf(question), start = Date.now();
		const content = readout.renderTurn({ question: question.question, options: form.texts, instruction: question.instruction });
		const { ids, base, text } = render(context.messages, content);
		if (!ids.length || ids.length >= seq.contextSize)
			throw fail('NOTJEV_CONTEXT_LIMIT', 'Native context would overflow; no implicit truncation is allowed');
		let prefix = 0;
		while (prefix < base.length && prefix < ids.length - 1 && base[prefix] === ids[prefix]) prefix++;
		try {
			await seq.adaptStateToTokens(ids.slice(0, prefix), false);
			const reused = seq.nextTokenIndex;
			await evaluate(ids.slice(reused, prefix), signal);
			if (prefix && seq.needsCheckpoints) await seq.takeCheckpoint();
			await evaluate(ids.slice(prefix, -1), signal);
			signal?.throwIfAborted();
			const out = await seq.controlledEvaluate([[ids[ids.length - 1], { generateNext: { probabilities: true, options: RAW_SAMPLING } }]]);
			signal?.throwIfAborted();
			if (!out[0]?.next?.probabilities) throw fail('NOTJEV_NO_LOGPROBS', 'Native backend returned no distribution');
			const keep = [];
			for (const l of readout.lettersOf(form.ids)) for (const s of [l, ' ' + l]) {
				const t = model.tokenize(s, false); if (t.length === 1) keep.push(t[0]);
			}
			const entries = probsToEntries(out[0].next.probabilities, id => model.detokenize([id]), { limit: 64, keep });
			const raw = { choices: [{ logprobs: { content: [{ top_logprobs: entries }] } }], model: options.model || options.modelPath };
			const r = readResponse(raw, { form, theta: question.theta ?? options.theta, prompt: text, ms: Date.now() - start });
			r.cache = { status: 'reported', cachedTokens: reused, checkpoint: !!(prefix && seq.needsCheckpoints) };
			r.usage = { prompt_tokens: ids.length, completion_tokens: 0, evaluated_tokens: ids.length - reused };
			return r;
		} catch (e) { await seq.clearHistory(); throw e; }
	}
	return {
		model: options.model || options.modelPath,
		info: runtime.info,
		validateContext: validateNativeContext,
		decideContext(request) {
			if (closed) return Promise.reject(fail('NOTJEV_CLOSED', 'Native backend is closed'));
			const run = tail.then(() => decide(request));
			tail = run.catch(() => {});
			return run;
		},
		close() {
			if (!closePromise) { closed = true; closePromise = tail.then(() => runtime.dispose()); }
			return closePromise;
		}
	};
}

module.exports = { createNativeContextBackend, validateNativeContext };
