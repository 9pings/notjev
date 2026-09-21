'use strict';
/** THE MINI APP — one state, N questions, one HTTP route, typed answers. */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../lib/server');
const { startFake, chatResponse, lp } = require('./helpers/fake-server');

async function up( handler, opts ) {
	const fake = await startFake(handler);
	const server = createServer(Object.assign({ baseUrl: fake.url, model: 'fake-model', env: {},
		retries: 0, log: null }, opts || {}));
	await new Promise(( r ) => server.listen(0, '127.0.0.1', r) );
	const url = 'http://127.0.0.1:' + server.address().port;
	return { fake, server, url, down: async () => { await new Promise(( r ) => server.close(r) ); await fake.close(); } };
}

const post = ( url, body ) => fetch(url + '/v1/decide', { method: 'POST',
	headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('serve — POST /v1/decide', () => {

	test('one state, N questions, one typed answer each', async () => {
		const t = await up(( b, req, n ) => chatResponse(lp(n === 1 ? [['A', 0.96], ['B', 0.04]] : [['B', 0.97], ['A', 0.03]])) );
		try {
			const r = await post(t.url, { state: 'S\n', theta: 0.5, questions: [
				{ id: 'verdict', question: 'verdict', options: ['SAME', 'OTHER'] },
				{ id: 'flag', question: 'flag', noul: { yes: 'Y', no: 'N' } },
			] });
			assert.strictEqual(r.status, 200);
			const j = await r.json();
			assert.strictEqual(j.results.length, 2);
			assert.strictEqual(j.results[0].choice, 'SAME');
			assert.strictEqual(j.results[0].id, 'verdict');
			assert.strictEqual(j.results[1].choice, 'N');
			assert.strictEqual(j.results[1].value, false, 'the `no` option must decode to false');
			assert.ok(j.results[0].p1 > 0.9 && j.results[0].band === 'certain');
			assert.strictEqual(j.results[0].raw, undefined, 'the server response is not echoed by default');
		} finally { await t.down(); }
	});

	test('`raw: true` returns the prompt and the server response — the first rung stays reachable', async () => {
		const t = await up(() => chatResponse(lp([['A', 0.96], ['B', 0.04]])) );
		try {
			const j = await (await post(t.url, { state: 'S', raw: true,
				questions: [{ question: 'q', options: ['A1', 'B1'] }] })).json();
			assert.ok(/Question: q\nA\. A1\nB\. B1$/.test(j.results[0].prompt));
			assert.ok(j.results[0].raw && j.results[0].raw.choices);
		} finally { await t.down(); }
	});

	test('NEGATIVE CONTROL — a body without questions, a bad JSON and an unknown route are REFUSED and NAMED', async () => {
		const t = await up(() => chatResponse(lp([['A', 1]])) );
		try {
			const noQ = await post(t.url, { state: 'S' });
			assert.strictEqual(noQ.status, 400);
			assert.strictEqual((await noQ.json()).error.code, 'NOTJEV_NO_QUESTION');
			const bad = await fetch(t.url + '/v1/decide', { method: 'POST', body: '{nope' });
			assert.strictEqual((await bad.json()).error.code, 'NOTJEV_BAD_JSON');
			const gone = await fetch(t.url + '/v1/nope');
			assert.strictEqual(gone.status, 404);
			assert.strictEqual((await gone.json()).error.code, 'NOTJEV_NO_ROUTE');
		} finally { await t.down(); }
	});

	test('NEGATIVE CONTROL — an upstream failure comes back as an ERROR PER QUESTION, never as a verdict', async () => {
		const t = await up(() => ({ status: 503, text: 'no engine' }) );
		try {
			const j = await (await post(t.url, { state: 'S', questions: [{ question: 'q', options: ['A', 'B'] }] })).json();
			assert.strictEqual(j.results[0].ok, false);
			assert.strictEqual(j.results[0].choice, null,
				'a failing upstream produced a verdict — that is a decision made by the error path');
			assert.strictEqual(j.results[0].code, 'NOTJEV_HTTP');
		} finally { await t.down(); }
	});

	test('/health says where it points, without calling the model', async () => {
		const t = await up(() => chatResponse(lp([['A', 1]])) );
		try {
			const j = await (await fetch(t.url + '/health')).json();
			assert.strictEqual(j.ok, true);
			assert.strictEqual(j.model, 'fake-model');
			assert.strictEqual(t.fake.requests.length, 0, '/health called the model — a health check must not cost a token');
		} finally { await t.down(); }
	});
});
