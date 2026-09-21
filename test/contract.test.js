'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/contract');
const { readResponse } = require('../lib/client');
const rec = require('./fixtures/recording.json');

/* ── L'ENTRÉE ─────────────────────────────────────────────────────────────────────────────── */

test('contract: une ligne d\'entrée { state, question, options } passe', () => {
	const r = C.validateInput({ id: 'q1', kind: 'choice', state: 'S', question: 'q', options: ['SAME', 'OTHER'] });
	assert.equal(r.ok, true);
	assert.equal(r.rendered, false);                                        // la lib rendra la chaîne
});

test('contract: une ligne d\'entrée { content, options, meta } passe — la chaîne DÉJÀ rendue', () => {
	const r = C.validateInput({ id: 'q2', kind: 'choice', content: 'Choose…\n\nQuestion: q\nA. x\nB. y',
		options: [{ id: 'x', description: 'le premier' }, 'y'], meta: { split: 'calib', teacher: 'gold', layer: 3 } });
	assert.equal(r.ok, true);
	assert.equal(r.rendered, true);                                         // octet pour octet, on n'y touche pas
});

test('contract: un `kind` inconnu refuse, et le refus se nomme', () => {
	assert.throws(() => C.validateInput({ id: 1, kind: 'ranking', content: 'x', options: ['a', 'b'] }),
		( e ) => e.code === 'CONTRACT_INPUT' && /kind/.test(e.message));
});

test('contract: ni `content` ni { question, options } = refus (il n\'y a rien à demander)', () => {
	assert.throws(() => C.validateInput({ id: 1, kind: 'choice', options: ['a', 'b'] }), ( e ) => e.code === 'CONTRACT_INPUT');
	assert.throws(() => C.validateInput({ id: 1, kind: 'choice', content: 'x', options: ['a'] }), ( e ) => e.code === 'CONTRACT_INPUT');
});

/* ── LA SORTIE ────────────────────────────────────────────────────────────────────────────── */

const out = () => {
	const row = rec.results[0];
	const d = readResponse(row.resp, { options: row.options, theta: 0.5, prompt: 'PROMPT' });
	return Object.assign({ id: row.id }, d, {
		prompt_sha256: C.sha256('PROMPT'), backend: 'vllm', model: rec.model, source: 'http',
	});
};

test('contract: une sortie complète (readResponse + sha, backend, model, source) passe', () => {
	const r = C.validateOutput(out());
	assert.equal(r.ok, true);
});

test('contract: une sortie SANS le champ coverage refuse — mais coverage: null PASSE', () => {
	const o = out();
	delete o.coverage;
	assert.throws(() => C.validateOutput(o), ( e ) => e.code === 'CONTRACT_OUTPUT' && /coverage/.test(e.message));
	// `source: 'logits'` sans `lse` : la coverage n'est pas 1, elle n'existe pas — et ça se dit.
	assert.equal(C.validateOutput(Object.assign(out(), { coverage: null, source: 'logits' })).ok, true);
});

test('contract: `layer` et `source` sont optionnels, et validés quand ils sont là', () => {
	const o = out();
	delete o.source;
	assert.equal(C.validateOutput(o).ok, true);                             // optionnel
	assert.equal(C.validateOutput(Object.assign(out(), { layer: 0 })).ok, true);
	assert.throws(() => C.validateOutput(Object.assign(out(), { layer: -1 })), ( e ) => e.code === 'CONTRACT_OUTPUT');
	assert.throws(() => C.validateOutput(Object.assign(out(), { layer: 2.5 })), ( e ) => e.code === 'CONTRACT_OUTPUT');
	assert.throws(() => C.validateOutput(Object.assign(out(), { source: 'guess' })), ( e ) => e.code === 'CONTRACT_OUTPUT');
});

test('contract: sha256 est celui d\'un prompt, pas celui d\'un objet', () => {
	assert.equal(C.sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
