'use strict';
/**
 * context-native.js — LE BACKEND NATIF, RUNTIME INJECTÉ.
 *
 * Pas de GPU ici : `options.load` reçoit un faux runtime (seq, model, render) et le test
 * vérifie les MÉCANIQUES — réutilisation du préfixe, checkpoint, file sérialisée, nettoyage sur
 * erreur, annulation entre blocs, refus explicites — qui sont exactement ce que le vrai modèle
 * exécute. Les chiffres réels sont dans bench/context-smoke.js, jamais dans cette suite.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { createNativeContextBackend, validateNativeContext } = require('../lib/context-native');

/** ids de prompt: 20 tokens ; base: 10 — le préfixe commun vaut donc 10. */
const IDS = Array.from({ length: 20 }, ( _, i ) => i + 1);
const BASE = IDS.slice(0, 10);

/** A=65..C=67 → ids 165..167 ; le vocabulaire du faux modèle n'a que ça d'intéressant. */
function fakeModel() {
	return {
		tokenize: ( s, special ) => (/^[A-C]$/.test(s) && !special) ? [100 + s.charCodeAt(0)] : [900],
		detokenize: ( ids ) => ids.map(( i ) => i >= 100 && i < 200 ? String.fromCharCode(i - 100) : '?').join(''),
	};
}

function fakeRuntime( o = {} ) {
	const calls = { adapt: [], eval: [], controlled: 0, checkpoint: 0, cleared: 0 };
	let inFlight = 0, maxInFlight = 0, disposed = 0;
	const seq = {
		contextSize: 4096,
		needsCheckpoints: o.needsCheckpoints !== false,
		nextTokenIndex: 0,
		async adaptStateToTokens( tokens ) { calls.adapt.push([...tokens]); seq.nextTokenIndex = o.reuseAfter ?? tokens.length; },
		async evaluateWithoutGeneratingNewTokens( tokens ) {
			inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
			try {
				calls.eval.push([...tokens]);
				if ( o.evalDelayMs ) await new Promise(( r ) => setTimeout(r, o.evalDelayMs));
				if ( o.failEval ) throw o.failEval;
			} finally { inFlight--; }
		},
		async takeCheckpoint() { calls.checkpoint++; },
		async controlledEvaluate( input ) {
			calls.controlled++;
			if ( o.failControlled ) { const e = o.failControlled; o.failControlled = null; throw e; }
			assert.equal(input.length, 1, 'controlledEvaluate lit UNE position');
			assert.equal(input[0][0], IDS[IDS.length - 1], 'la position lue est le DERNIER token du prompt');
			return [{ next: { probabilities: o.probs || new Map([[165, 0.9], [166, 0.05], [900, 0.05]]) } }];
		},
		async clearHistory() { calls.cleared++; },
	};
	const runtime = {
		seq, model: fakeModel(),
		render( messages, questionText ) {
			assert.ok(questionText.includes('ORANGE'), 'le tour question rendu part dans le prompt');
			return { ids: [...IDS], base: [...BASE], text: '<|im_start|>user\n…<|im_end|>\n<|im_start|>assistant\n' };
		},
		info: { gpu: 'fake', gpuLayers: 66, render: 'chatml(thinkingOff)', needsCheckpoints: seq.needsCheckpoints },
		async dispose() { disposed++; },
	};
	return { runtime, calls, disposedCount: () => disposed, maxInFlight: () => maxInFlight };
}

function backend( o, runtime ) {
	return createNativeContextBackend(Object.assign({ load: async () => runtime.runtime }, o));
}

const CONTEXT = () => ({ type: 'messages', messages: [{ role: 'user', content: 'Le code est ORANGE.' }] });
const QUESTION = () => ({ id: 'code', question: 'Quel mot de code ?', options: ['ORANGE', 'BLUE', 'UNKNOWN'] });

describe('context-native — le readout', () => {
	test('préfixe réutilisé : adapt puis checkpoint, le reste évalué, cache RAPPORTÉ', async () => {
		const f = fakeRuntime({ reuseAfter: 4 });
		const b = await backend({}, f);
		const r = await b.decideContext({ context: CONTEXT(), question: QUESTION() });
		assert.equal(r.choice, 'ORANGE');
		assert.deepEqual(f.calls.adapt[0], BASE, 'adapt reçoit le préfixe commun');
		assert.equal(f.calls.checkpoint, 1, 'un checkpoint après le préfixe');
		assert.deepEqual(f.calls.eval[0], BASE.slice(4), 'seul le solde du préfixe est évalué');
		assert.deepEqual(f.calls.eval[1], IDS.slice(10, -1), 'puis le tour question, sans le dernier token');
		assert.deepEqual(r.cache, { status: 'reported', cachedTokens: 4, checkpoint: true });
		assert.deepEqual(r.usage, { prompt_tokens: 20, completion_tokens: 0, evaluated_tokens: 16 });
		await b.close();
	});

	test('état déjà en place : RÉUTILISATION TOTALE, zéro évaluation du préfixe', async () => {
		const f = fakeRuntime();
		const b = await backend({}, f);
		const r = await b.decideContext({ context: CONTEXT(), question: QUESTION() });
		assert.deepEqual(f.calls.eval[0], IDS.slice(10, -1));
		assert.deepEqual(r.cache, { status: 'reported', cachedTokens: 10, checkpoint: true });
		await b.close();
	});

	test('échec de l\'inférence : l\'historique est NETTOYÉ et l\'erreur remonte', async () => {
		const f = fakeRuntime({ failControlled: Object.assign(new Error('boom'), { code: 'NOTJEV_X' }) });
		const b = await backend({}, f);
		await assert.rejects(() => b.decideContext({ context: CONTEXT(), question: QUESTION() }), { code: 'NOTJEV_X' });
		assert.equal(f.calls.cleared, 1);
		const ok = await b.decideContext({ context: CONTEXT(), question: QUESTION() });
		assert.equal(ok.choice, 'ORANGE');
		await b.close();
	});

	test('annulation entre blocs : chunkSize borné, signal respecté, historique nettoyé', async () => {
		const f = fakeRuntime({ reuseAfter: 0, evalDelayMs: 15 });
		const b = await backend({ chunkSize: 2 }, f);
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 20);
		await assert.rejects(() => b.decideContext({ context: CONTEXT(), question: QUESTION(), signal: ac.signal }));
		assert.ok(f.calls.eval.every(( t ) => t.length <= 2), 'l\'évaluation avance par blocs bornés');
		assert.equal(f.calls.cleared, 1);
		await b.close();
	});

	test('contexte trop grand : refusé AVANT l\'inférence, sans troncature implicite', async () => {
		const f = fakeRuntime();
		const big = { runtime: f.runtime };
		f.runtime.render = () => ({ ids: Array.from({ length: 5000 }, ( _, i ) => i ), base: [], text: 'x' });
		const b = await backend({}, big);
		await assert.rejects(() => b.decideContext({ context: CONTEXT(), question: QUESTION() }), { code: 'NOTJEV_CONTEXT_LIMIT' });
		assert.equal(f.calls.controlled, 0);
		await b.close();
	});
});

describe('context-native — la file et le cycle de vie', () => {
	test('UNE séquence sérialisée : jamais deux inférences en parallèle', async () => {
		const f = fakeRuntime({ reuseAfter: 0, evalDelayMs: 20 });
		const b = await backend({}, f);
		await Promise.all([b.decideContext({ context: CONTEXT(), question: QUESTION() }),
			b.decideContext({ context: CONTEXT(), question: QUESTION() })]);
		assert.equal(f.maxInFlight(), 1);
		await b.close();
	});

	test('close() : les vols en cours TERMINENT, le runtime est libéré UNE fois, tout refus ensuite', async () => {
		const f = fakeRuntime({ reuseAfter: 0, evalDelayMs: 30 });
		const b = await backend({}, f);
		const inFlight = b.decideContext({ context: CONTEXT(), question: QUESTION() });
		const closing = b.close();
		await assert.rejects(() => b.decideContext({ context: CONTEXT(), question: QUESTION() }), { code: 'NOTJEV_CLOSED' });
		const r = await inFlight;
		assert.equal(r.choice, 'ORANGE');
		await closing;
		assert.equal(f.disposedCount(), 1);
		await b.close();
		assert.equal(f.disposedCount(), 1, 'close est idempotent');
	});
});

describe('context-native — refus explicites (pas de natif multimodal ni thinking ici)', () => {
	test('validateContext nomme ce que le backend ne fait pas', async () => {
		assert.throws(() => validateNativeContext({ messages: [{ role: 'user', content: 'x' }], tools: [{}] }),
			{ code: 'NOTJEV_NATIVE_CONTEXT_UNSUPPORTED' });
		assert.throws(() => validateNativeContext({ messages: [{ role: 'tool', tool_call_id: 'c', content: 'x' }] }),
			{ code: 'NOTJEV_NATIVE_CONTEXT_UNSUPPORTED' });
		assert.throws(() => validateNativeContext({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }] }] }),
			{ code: 'NOTJEV_NATIVE_VISION_UNSUPPORTED' });
		assert.throws(() => validateNativeContext({ messages: [], templateKwargs: { enable_thinking: true } }),
			{ code: 'NOTJEV_NATIVE_TEMPLATE_UNSUPPORTED' });
		assert.throws(() => validateNativeContext({ messages: [], templateKwargs: { autre: 1 } }),
			{ code: 'NOTJEV_NATIVE_TEMPLATE_UNSUPPORTED' });
		assert.doesNotThrow(() => validateNativeContext({ messages: [], templateKwargs: { enable_thinking: false } }));
		await assert.rejects(() => createNativeContextBackend({ mmproj: 'x.gguf' }), { code: 'NOTJEV_NATIVE_VISION_UNSUPPORTED' });
	});
});
