'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/backends/llama-server');

const respNew = { content: 'B', tokens_evaluated: 12, completion_probabilities: [{ id: 33, token: 'B', logprob: -0.05,
	top_logprobs: [{ id: 33, token: 'B', logprob: -0.05 }, { id: 32, token: 'A', logprob: -3.1 }, { id: 9, token: ' B', logprob: -6 }] }] };
const respOld = { content: 'B', completion_probabilities: [{ content: 'B', probs: [{ tok_str: 'B', prob: 0.95 }, { tok_str: 'A', prob: 0.04 }] }] };

test('llama-server: les deux formes de completion_probabilities donnent des entries', () => {
	assert.deepEqual(L.entriesOfLlamaServer(respNew).slice(0, 2), [{ token: 'B', logprob: -0.05 }, { token: 'A', logprob: -3.1 }]);
	const e = L.entriesOfLlamaServer(respOld);
	assert.equal(e[0].token, 'B'); assert.ok(Math.abs(Math.exp(e[0].logprob) - 0.95) < 1e-9);
	assert.deepEqual(L.entriesOfLlamaServer({}), []);
});

test('llama-server: decide envoie la chaîne ChatML exacte à /completion et lit un verdict', async () => {
	const calls = [];
	const fetchFake = async ( url, init ) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => respNew }; };
	const c = L.createLlamaServerClient({ baseUrl: 'http://h:8080', fetch: fetchFake, theta: 0.5 });
	const d = await c.decide({ state: 'S', question: 'q', options: ['SAME', 'OTHER'] });
	assert.equal(calls[0].url, 'http://h:8080/completion');
	assert.equal(calls[0].body.n_predict, 1); assert.equal(calls[0].body.n_probs, 40); assert.equal(calls[0].body.cache_prompt, false);
	assert.ok(calls[0].body.prompt.startsWith('<|im_start|>user\n'));
	assert.ok(calls[0].body.prompt.endsWith('<|im_start|>assistant\n<think>\n\n</think>\n\n'));
	assert.equal(d.choice, 'OTHER'); assert.equal(d.backend, 'llama-server'); assert.ok(d.coverage > 0.9);
});

test('llama-server: decideMany garde l\'ordre et les ids', async () => {
	const fetchFake = async () => ({ ok: true, json: async () => respNew });
	const c = L.createLlamaServerClient({ baseUrl: 'http://h:8080', fetch: fetchFake });
	const rows = await c.decideMany('S', [{ id: 'a', question: 'q', options: ['x', 'y'] }, { id: 'b', question: 'q', noul: true }], { concurrency: 2 });
	assert.deepEqual(rows.map(( r ) => r.id ), ['a', 'b']);
	assert.equal(rows[1].kind, 'noul');
});
