'use strict';
/** THE JEV WIRE CONTRACT — POST /v1/systemone: the translation is tested against a REAL socket. */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../lib/server');
const wire = require('../lib/wire');
const { startFake, chatResponse, lp } = require('./helpers/fake-server');

async function up( handler, opts ) {
	const fake = await startFake(handler);
	const server = createServer(Object.assign({ baseUrl: fake.url, model: 'fake-model', env: {},
		retries: 0, log: null }, opts || {}));
	await new Promise(( r ) => server.listen(0, '127.0.0.1', r) );
	const url = 'http://127.0.0.1:' + server.address().port;
	return { fake, server, url, down: async () => { await new Promise(( r ) => server.close(r) ); await fake.close(); } };
}

const post = ( url, body, token ) => fetch(url + '/v1/systemone', { method: 'POST',
	headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
	body: JSON.stringify(body) });

const REQUEST = { state: 'Everything is down, demo at noon.\n', questions: {
	urgent: { type: 'noul', instructions: 'does the customer need a reply within the hour?',
		criteria: { true: 'the clock is running', false: 'it can wait' } },
	team  : { type: 'choice', instructions: 'which team should handle it?',
		criteria: { outage: 'service down', billing: 'charges, refunds', feature: 'requests, how-to' } },
	tone  : { type: 'score', instructions: 'how upset is the customer?',
		criteria: ['calm', 'annoyed', 'furious'] },
} };

describe('wire — POST /v1/systemone', () => {

	test('the three question types come back grouped, typed, with the instrument attached', async () => {
		/* decideMany runs in order: urgent (letters A/B), team (A/B/C), tone (A/B/C). */
		const t = await up(( b, req, n ) => chatResponse(lp(
			n === 1 ? [['A', 0.9], ['B', 0.1]]
			: n === 2 ? [['B', 0.7], ['A', 0.2], ['C', 0.1]]
			: [['B', 0.6], ['A', 0.3], ['C', 0.1]])));
		try {
			const r = await post(t.url, REQUEST);
			assert.strictEqual(r.status, 200);
			const j = await r.json();
			assert.strictEqual(j.model, 'fake-model');
			/* noul: P(yes), first option of the pair */
			assert.ok(Math.abs(j.answers.nouls.urgent.noul - 0.9) < 1e-9);
			assert.ok(j.answers.nouls.urgent.confidence > 0.3, 'a 0.9/0.1 read is not near-uniform');
			/* choice: the code in the CALLER's order, probabilities over the criteria names */
			assert.strictEqual(j.answers.choices.team.choice, 'billing');
			assert.ok(Math.abs(j.answers.choices.team.probabilities.outage - 0.2) < 1e-9);
			assert.ok(Math.abs(j.answers.choices.team.probabilities.billing - 0.7) < 1e-9);
			/* score: the EXPECTED level, 0-indexed — 0·0.3 + 1·0.6 + 2·0.1 = 0.8 */
			assert.ok(Math.abs(j.answers.scores.tone.score - 0.8) < 1e-9);
			assert.deepStrictEqual(j.answers.scores.tone.legend, ['calm', 'annoyed', 'furious']);
			/* the notjev block: the fields the wire contract has no room for */
			assert.ok(j.answers.choices.team.notjev.coverage > 0.99);
			assert.strictEqual(j.answers.choices.team.notjev.theta, 0, 'the wire default abstains never');
			assert.ok(j.answers.nouls.urgent.notjev.band);
			/* usage: summed over the questions, Jev field names */
			assert.strictEqual(j.usage.input_tokens, 126, '3 questions x 42 prompt tokens');
			assert.strictEqual(j.usage.output_tokens, 3, '3 questions x 1 token read');
		} finally { await t.down(); }
	});

	test('a DEGRADED readout is a null answer with the reason — never a verdict the model did not give', async () => {
		const t = await up(() => chatResponse(lp([['The', 0.9], ['model', 0.1]])));
		try {
			const j = await (await post(t.url, { state: 'S\n', questions: {
				q: { type: 'choice', instructions: 'pick', criteria: { a: 'one', b: 'two' } },
				s: { type: 'score', instructions: 'grade', criteria: ['x', 'y', 'z'] },
			} })).json();
			assert.strictEqual(j.answers.choices.q.choice, null);
			assert.strictEqual(j.answers.choices.q.notjev.degraded, true);
			assert.strictEqual(j.answers.choices.q.confidence, 0, 'uniform over the options: no information');
			assert.strictEqual(j.answers.scores.s.score, null, 'no option mass, no expectation — 0 would lie');
		} finally { await t.down(); }
	});

	test('`theta` (notjev extension): a high bar abstains on a close read, and says so', async () => {
		const t = await up(() => chatResponse(lp([['A', 0.55], ['B', 0.45]])));
		try {
			const j = await (await post(t.url, { state: 'S\n', theta: 0.99, questions: {
				q: { type: 'choice', instructions: 'pick', criteria: { a: 'one', b: 'two' } },
			} })).json();
			assert.strictEqual(j.answers.choices.q.choice, null);
			assert.strictEqual(j.answers.choices.q.notjev.undecided, true);
			assert.ok(Math.abs(j.answers.choices.q.probabilities.a - 0.55) < 1e-9,
				'the abstention is about the verdict, not the mass: the distribution stays');
		} finally { await t.down(); }
	});

	test('NEGATIVE CONTROL — a request the readout cannot honour is refused 422 BEFORE the engine is spent', async () => {
		const t = await up(() => chatResponse(lp([['A', 1]])));
		try {
			assert.strictEqual(t.fake.requests.length, 0);
			const noState = await post(t.url, { questions: REQUEST.questions });
			assert.strictEqual(noState.status, 422);
			assert.strictEqual((await noState.json()).detail[0].loc[1], 'state');
			const badType = await post(t.url, { state: 'S\n', questions: {
				q: { type: 'verdict', instructions: 'x' } } });
			assert.strictEqual(badType.status, 422);
			assert.deepStrictEqual((await badType.json()).detail[0].loc, ['body', 'questions', 'q', 'type']);
			/* 27 options: Jev allows 255, the letter regime does not — refused, never truncated */
			const big = {}; for ( let i = 0; i < 27; i++ ) big['o' + i] = 'option ' + i;
			const tooMany = await post(t.url, { state: 'S\n', questions: {
				q: { type: 'choice', instructions: 'x', criteria: big } } });
			assert.strictEqual(tooMany.status, 422);
			assert.match((await tooMany.json()).detail[0].msg, /at most 26/);
			const oneLevel = await post(t.url, { state: 'S\n', questions: {
				q: { type: 'score', instructions: 'x', criteria: ['only'] } } });
			assert.strictEqual(oneLevel.status, 422);
			assert.match((await oneLevel.json()).detail[0].msg, /at least 2 options/);
			assert.strictEqual(t.fake.requests.length, 0, 'a refused request must cost NO token');
		} finally { await t.down(); }
	});

	test('an upstream failure is a 502 for the WHOLE request — no half-filled answers', async () => {
		const t = await up(() => ({ status: 503, text: 'no engine' }));
		try {
			const r = await post(t.url, REQUEST);
			assert.strictEqual(r.status, 502);
			const j = await r.json();
			assert.strictEqual(j.detail.error_type, 'upstream_error');
			assert.match(j.detail.message, /urgent/);
		} finally { await t.down(); }
	});

	test('apiKey (optional): the POST routes are bearer-guarded, /health and /v1/models are not', async () => {
		const t = await up(() => chatResponse(lp([['A', 1], ['B', 0]])), { apiKey: 'sk-secret' });
		try {
			const none = await post(t.url, { state: 'S\n', questions: {
				q: { type: 'noul', instructions: 'x' } } });
			assert.strictEqual(none.status, 401);
			assert.strictEqual((await none.json()).detail.error_type, 'unauthorized');
			const wrong = await post(t.url, { state: 'S\n', questions: {
				q: { type: 'noul', instructions: 'x' } } }, 'sk-wrong');
			assert.strictEqual(wrong.status, 401);
			const ok = await post(t.url, { state: 'S\n', questions: {
				q: { type: 'noul', instructions: 'x' } } }, 'sk-secret');
			assert.strictEqual(ok.status, 200);
			const health = await fetch(t.url + '/health');
			assert.strictEqual(health.status, 200, 'a health check needs no token');
			const models = await fetch(t.url + '/v1/models');
			assert.strictEqual(models.status, 200);
		} finally { await t.down(); }
	});

	test('GET /v1/models lists the served engine and the aliases an SDK defaults to', async () => {
		const t = await up(() => chatResponse(lp([['A', 1]])));
		try {
			const ids = (await (await fetch(t.url + '/v1/models')).json()).data.map(( m ) => m.id );
			assert.ok(ids.indexOf('fake-model') >= 0);
			assert.ok(ids.indexOf('jev-latest') >= 0, 'a typesafe-sdk default must resolve');
			assert.ok(ids.indexOf('jev-preview') >= 0);
		} finally { await t.down(); }
	});
});

describe('wire — the pure translation', () => {

	test('the criteria become the menu: descriptions render, bare codes stay bare', () => {
		const w = wire.toQuestions({ state: 'S\n', questions: {
			q: { type: 'choice', instructions: 'pick', criteria: { a: 'the first', b: '' } },
		} });
		assert.deepStrictEqual(w.specs[0].ids, ['a', 'b']);
		assert.strictEqual(w.questions[0].question, 'pick');
		/* `a` has a description, `b` is a bare code: the prompt must show the difference */
		const opts = w.questions[0].options;
		assert.strictEqual(opts[0].description, 'the first');
		assert.strictEqual(opts[1], 'b');
	});

	test('confidence: certain = 1, uniform = 0, and the formula in between', () => {
		assert.strictEqual(wire.confidenceOf([1, 0]), 1);
		assert.ok(Math.abs(wire.confidenceOf([0.5, 0.5])) < 1e-12);
		assert.ok(Math.abs(wire.confidenceOf([1 / 3, 1 / 3, 1 / 3])) < 1e-12);
		const h = -0.9 * Math.log(0.9) - 0.1 * Math.log(0.1);
		assert.ok(Math.abs(wire.confidenceOf([0.9, 0.1]) - (1 - h / Math.log(2))) < 1e-12);
	});
});
