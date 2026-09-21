'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entriesFromLetterLogits, entriesFromVocabLogprobs } = require('../lib/logits');
const readout = require('../lib/readout');

test('logits: les logits de lettres deviennent des entries lisibles par distribution', () => {
	// logits bruts de A, B et lse du vocabulaire : logprob = logit - lse
	const entries = entriesFromLetterLogits({ letters: ['A', 'B'], logits: [2.0, 0.0], lse: 2.5 });
	assert.deepEqual(entries.map(( e ) => e.token ), ['A', 'B']);
	assert.ok(Math.abs(entries[0].logprob - (2.0 - 2.5)) < 1e-12);
	const d = readout.distribution(entries, ['A', 'B']);
	assert.ok(Math.abs(d.probabilities[0] - Math.exp(2.0) / (Math.exp(2.0) + Math.exp(0.0))) < 1e-9);
	assert.ok(Math.abs(d.coverage - (Math.exp(-0.5) + Math.exp(-2.5))) < 1e-9);
});

test('logits: les variantes d\'espace sont des entries distinctes (" A"), agrégées par distribution', () => {
	const entries = entriesFromLetterLogits({ letters: ['A', 'B'], logits: [1, 1], lse: 3, spacedLogits: [0, -1] });
	assert.equal(entries.length, 4);
	assert.equal(entries[2].token, ' A');
	const d = readout.distribution(entries, ['A', 'B']);
	assert.ok(d.spacedMass > 0 && d.exactMass > 0);
});

test('logits: -Infinity partout = distribution dégradée, jamais l\'uniforme en silence', () => {
	const entries = entriesFromLetterLogits({ letters: ['A', 'B'], logits: [-Infinity, -Infinity], lse: 0 });
	assert.equal(entries.length, 0);
	assert.equal(readout.distribution(entries, ['A', 'B']).degraded, true);
});

test('logits: la forme { token: logprob } de /v1/completions', () => {
	const e = entriesFromVocabLogprobs({ A: -0.1, ' B': -2.3, The: -4 });
	assert.deepEqual(e, [{ token: 'A', logprob: -0.1 }, { token: ' B', logprob: -2.3 }, { token: 'The', logprob: -4 }]);
});

test('logits: contrat refusé quand logits et lettres divergent', () => {
	assert.throws(() => entriesFromLetterLogits({ letters: ['A', 'B'], logits: [1], lse: 0 }), /LOGITS_SHAPE/);
});

test('logits: tokens explicites, variantes séparées, lse optionnel → relatif', () => {
	const { entriesFromLogits, decideFromLogits } = require('../lib/logits');
	const abs = entriesFromLogits({ tokens: [{ token: 'A', logit: 2 }, { token: ' A', logit: -1 }, { token: 'B', logit: 0 }, { token: ' B', logit: -3 }], lse: 2.5 });
	assert.equal(abs.length, 4); assert.equal(abs.relative, undefined);
	const rel = entriesFromLogits({ tokens: [{ token: 'A', logit: 2 }, { token: 'B', logit: 0 }] });
	assert.equal(rel.relative, true);
	assert.ok(Math.abs(Math.exp(rel[0].logprob) + Math.exp(rel[1].logprob) - 1) < 1e-9);   // softmax sur les tokens fournis
	const d = decideFromLogits({ tokens: [{ token: 'A', logit: 2 }, { token: 'B', logit: 0 }], options: ['SAME', 'OTHER'], theta: 0.5 });
	assert.equal(d.choice, 'SAME'); assert.equal(d.coverage, null); assert.equal(d.source, 'logits'); assert.equal(d.degraded, false);
	const d2 = decideFromLogits({ tokens: [{ token: 'A', logit: 2 }, { token: 'B', logit: 0 }], lse: 2.5, options: ['SAME', 'OTHER'] });
	assert.ok(d2.coverage > 0 && d2.coverage < 1);
});
