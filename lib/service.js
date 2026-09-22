'use strict';

const { createContextStore, normalizeContext, positive, copy } = require('./context');
const { formOf } = require('./client');
const { fail } = require('./errors');

const QUESTION_FIELDS = new Set(['id', 'question', 'options', 'noul', 'score', 'theta', 'instruction']);
function validateQuestions(questions, maxQuestions) {
	if (!Array.isArray(questions) || !questions.length || questions.length > maxQuestions)
		throw fail('NOTJEV_BAD_QUESTIONS', 'questions must contain 1..' + maxQuestions + ' items');
	const ids = new Set();
	return questions.map((input, i) => {
		if (!input || typeof input !== 'object') throw fail('NOTJEV_BAD_QUESTIONS', 'Invalid question');
		for (const key of Object.keys(input)) if (!QUESTION_FIELDS.has(key))
			throw fail('NOTJEV_BAD_QUESTIONS', 'Unknown question field: ' + key);
		const q = copy(input);
		q.id = q.id === undefined ? String(i) : q.id;
		if (typeof q.id !== 'string' || !q.id || ids.has(q.id)) throw fail('NOTJEV_BAD_QUESTIONS', 'Question IDs must be unique nonempty strings');
		ids.add(q.id);
		if (typeof q.question !== 'string' || !q.question) throw fail('NOTJEV_BAD_QUESTIONS', 'question must be nonempty text');
		if (q.instruction !== undefined && typeof q.instruction !== 'string') throw fail('NOTJEV_BAD_QUESTIONS', 'instruction must be text');
		if (q.theta !== undefined && (!Number.isFinite(q.theta) || q.theta < 0 || q.theta > 1))
			throw fail('NOTJEV_BAD_QUESTIONS', 'theta must be between 0 and 1');
		if (['options', 'noul', 'score'].filter(k => q[k] !== undefined).length !== 1)
			throw fail('NOTJEV_BAD_QUESTIONS', 'Supply exactly one question form');
		formOf(q);
		return q;
	});
}
function compact(r, id) {
	const out = { id, status: r.degraded ? 'degraded' : r.undecided ? 'undecided' : 'decided' };
	for (const k of ['choice', 'value', 'margin', 'p1', 'coverage', 'degraded', 'undecided', 'expectation', 'model', 'ms', 'usage', 'cache'])
		if (r[k] !== undefined) out[k] = r[k];
	return out;
}

function createDecisionService(options = {}) {
	const backend = options.backend || require('./context-http').createHttpContextBackend(options);
	if (typeof backend.decideContext !== 'function') throw fail('NOTJEV_BAD_BACKEND', 'Backend must implement decideContext');
	const store = options.store || createContextStore(options.storeOptions);
	const maxQuestions = positive(options.maxQuestions, 64, 'maxQuestions');
	const concurrency = positive(options.concurrency, 1, 'concurrency');
	const timeoutMs = positive(options.timeoutMs, 60000, 'timeoutMs');
	const maxContextBytes = positive(options.maxContextBytes, 16 * 1024 * 1024, 'maxContextBytes');
	const tasks = new Set();
	let closed = false;
	function assertOpen() { if (closed) throw fail('NOTJEV_CLOSED', 'Decision service is closed'); }
	return {
		store,
		putContext(input, { scope = 'local' } = {}) { assertOpen(); return store.put(input, scope); },
		dropContext(ref, { scope = 'local' } = {}) { assertOpen(); return store.drop(ref, scope); },
		async decide(input, { scope = 'local', signal } = {}) {
			assertOpen();
			if (!input || typeof input !== 'object') throw fail('NOTJEV_BAD_REQUEST', 'Decision request is required');
			for (const k of Object.keys(input)) if (!['context', 'questions', 'execution'].includes(k))
				throw fail('NOTJEV_BAD_REQUEST', 'Unknown request field: ' + k);
			if (input.execution !== undefined && input.execution !== 'independent')
				throw fail('NOTJEV_UNSUPPORTED_EXECUTION', 'Contextual decisions currently support independent execution');
			const questions = validateQuestions(input.questions, maxQuestions);
			let lease;
			if (input.context?.type === 'snapshot') {
				if (Object.keys(input.context).some(k => !['type', 'ref'].includes(k))) throw fail('NOTJEV_BAD_CONTEXT', 'Snapshot takes only ref');
				lease = store.acquire(input.context.ref, scope);
			}
			const controller = new AbortController();
			const abort = () => controller.abort(signal.reason);
			if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
			const timer = setTimeout(() => controller.abort(fail('NOTJEV_TIMEOUT', 'Decision batch timed out')), timeoutMs);
			let finish;
			const done = new Promise(resolve => { finish = resolve; });
			const task = { controller, done }; tasks.add(task);
			try {
				const context = lease ? lease.data : normalizeContext(input.context);
				if (Buffer.byteLength(JSON.stringify(context)) > maxContextBytes) throw fail('NOTJEV_CONTEXT_LIMIT', 'Context exceeds request byte limit');
				if (context.model && context.model !== backend.model) throw fail('NOTJEV_MODEL_MISMATCH', 'Snapshot model differs from configured backend');
				if (backend.validateContext) backend.validateContext(context);
				let next = 0;
				const results = new Array(questions.length);
				await Promise.all(Array.from({ length: Math.min(concurrency, questions.length) }, async () => {
					while (next < questions.length && !controller.signal.aborted) {
						const i = next++, q = questions[i];
						try {
							const r = await backend.decideContext({ context: copy(context), question: q, signal: controller.signal });
							results[i] = compact(r, q.id);
						} catch (e) {
							results[i] = { id: q.id, status: 'error', error: { code: e.code || 'NOTJEV_BACKEND_ERROR', message: e.message } };
						}
					}
				}));
				controller.signal.throwIfAborted();
				return { contextRef: lease ? input.context.ref : null, model: backend.model || null, results };
			} finally {
				clearTimeout(timer); signal?.removeEventListener('abort', abort); lease?.release(); tasks.delete(task); finish();
			}
		},
		async close() {
			closed = true;
			for (const t of tasks) t.controller.abort(fail('NOTJEV_CLOSED', 'Service is closing'));
			await Promise.all([...tasks].map(t => t.done));
			store.clear();
			if (options.ownsBackend && backend.close) await backend.close();
		}
	};
}

module.exports = { createDecisionService, validateQuestions };
