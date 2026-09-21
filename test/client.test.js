'use strict';
/**
 * THE CLIENT, AGAINST A REAL SOCKET.
 *
 * A stubbed `fetch` cannot fail the way a server fails (a 500 body, a truncated JSON, a hang), so
 * every test here talks to a small HTTP server that answers with a distribution the test chose.
 * The negative controls are the two failures that MUST NOT be silent: a distribution with no
 * option letter (the model answered something else) and a margin under theta.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { createClient } = require('../lib/client');
const { startFake, chatResponse, completionsResponse, lp } = require('./helpers/fake-server');

const strongA = () => chatResponse(lp([['A', 0.95], ['B', 0.04], ['The', 0.01]]));
const clientOn = ( fake, opts ) => createClient(Object.assign({ baseUrl: fake.url, model: 'fake-model',
	retries: 0, env: {} }, opts || {}));

describe('client — one request, one decision', () => {

	test('a decision carries the verdict, the probability, the margin, the band, the coverage and the '
		+ 'EXACT prompt', async () => {
		const fake = await startFake(() => strongA() );
		try {
			const jev = clientOn(fake);
			const r = await jev.decide({ state: 'S\n', question: 'verdict', options: ['SAME', 'OTHER'] });
			assert.strictEqual(r.choice, 'SAME');
			assert.strictEqual(r.value, 'SAME');
			assert.strictEqual(r.undecided, false);
			assert.strictEqual(r.degraded, false);
			assert.ok(Math.abs(r.p1 - 0.95 / 0.99) < 1e-9, 'p1 is renormalised over the options');
			assert.ok(Math.abs(r.coverage - 0.99) < 1e-9, 'coverage counts the mass outside the options');
			assert.strictEqual(r.band, 'certain');
			assert.strictEqual(r.prior, 0.95, 'the prior is the MIDDLE of the band, never the raw float');
			assert.deepStrictEqual(r.letters, ['A', 'B']);
			assert.deepStrictEqual(Object.keys(r.byOption), ['SAME', 'OTHER']);
			assert.strictEqual(r.prompt,
				'Choose the correct option. Reply with only its letter.\n\nContext:\nS\n\n\n'
				+ 'Question: verdict\nA. SAME\nB. OTHER',
				'the prompt returned must be the one that was SENT — it is the first rung of any diagnosis');
			assert.strictEqual(fake.requests[0].body.messages[0].content, r.prompt,
				'the server received something else than what the client reports: the report would be a lie');
			assert.strictEqual(fake.requests[0].body.max_tokens, 1);
			assert.strictEqual(fake.requests[0].body.logprobs, true);
			assert.strictEqual(fake.requests[0].body.top_logprobs, 20);
			assert.strictEqual(fake.requests[0].body.model, 'fake-model');
			assert.ok(r.ms >= 0 && r.usage && r.usage.total_tokens === 43);
			assert.ok(/"readout"/.test(r.readoutRaw), 'the loggable RAW must be the distribution');
		} finally { await fake.close(); }
	});

	test('NEGATIVE CONTROL — a distribution WITHOUT any option letter returns `degraded: true`, '
		+ '`choice: null`, and NEVER a silent uniform', async () => {
		const fake = await startFake(() => chatResponse(lp([['The', 0.7], ['Both', 0.3]])) );
		try {
			const r = await clientOn(fake).decide({ state: 'S', question: 'q', options: ['SAME', 'OTHER'], theta: 0 });
			assert.strictEqual(r.degraded, true,
				'the model answered outside the codomain and the client reported a normal decision — a silent '
				+ 'uniform reads as hesitation');
			assert.strictEqual(r.ok, false);
			assert.strictEqual(r.coverage, 0);
			assert.deepStrictEqual(r.probabilities, [0.5, 0.5], 'the uniform is returned, and NAMED by `degraded`');
			assert.strictEqual(r.choice, null,
				'A VERDICT WAS RETURNED ON AN EMPTY DISTRIBUTION (choice=' + JSON.stringify(r.choice) + ') — '
				+ 'even at theta = 0 a degraded readout must not decide');
			assert.ok(/NO option mass/.test(r.explain()), 'the explanation must NAME the cause');
		} finally { await fake.close(); }
	});

	test('NEGATIVE CONTROL — a margin under theta returns `undecided: true` and `choice: null`, while '
		+ 'the SAME distribution at theta = 0 decides', async () => {
		const fake = await startFake(() => chatResponse(lp([['A', 0.6], ['B', 0.4]])) );
		try {
			const jev = clientOn(fake);
			const q = { state: 'S', question: 'q', options: ['SAME', 'OTHER'] };
			const under = await jev.decide(Object.assign({ theta: 0.5 }, q));
			assert.ok(Math.abs(under.margin - 0.2) < 1e-9);
			assert.strictEqual(under.undecided, true);
			assert.strictEqual(under.choice, null,
				'A MARGIN OF 0.2 UNDER theta = 0.5 RETURNED A VERDICT — the abstention is not applied');
			assert.strictEqual(under.value, null, 'the typed value must abstain with the choice');
			assert.strictEqual(under.top, 'SAME', 'the top stays readable, it is simply not applied');
			const at0 = await jev.decide(Object.assign({ theta: 0 }, q));
			assert.strictEqual(at0.choice, 'SAME',
				'at theta = 0 nothing is decided either — then the abstention does not come from theta');
		} finally { await fake.close(); }
	});

	test('`noul` takes ITS TWO OPTIONS FROM THE CALLER — no word of any language is built in', async () => {
		const fake = await startFake(() => strongA() );
		try {
			const jev = clientOn(fake);
			const r = await jev.noul('S', 'is it so?', { yes: 'OUI', no: 'NON' });
			assert.strictEqual(r.choice, 'OUI');
			assert.strictEqual(r.value, true, 'the `yes` option maps to true, whatever it is CALLED');
			assert.ok(/A\. OUI\nB\. NON$/.test(fake.requests[0].body.messages[0].content),
				'the menu must carry the caller words, in the caller order');
			const bare = await jev.noul('S', 'is it so?');
			assert.ok(/A\. true\nB\. false$/.test(fake.requests[1].body.messages[0].content),
				'with no pair given, the literals true/false are used — they are not words of a language');
			assert.strictEqual(bare.value, true);
		} finally { await fake.close(); }
	});

	test('`score` reads the LETTER of the grade and returns the EXPECTATION over the whole distribution', async () => {
		// the menu is `D. 4` / `E. 5`: what is read is the LETTER, always — the digits are the CODES
		const fake = await startFake(() => chatResponse(lp([['D', 0.5], ['E', 0.5]])) );
		try {
			const r = await clientOn(fake).score('S', 'how much?', { min: 1, max: 5 }, { theta: 0 });
			assert.deepStrictEqual(r.options, ['1', '2', '3', '4', '5']);
			assert.strictEqual(r.value, 4, 'ties go to the first index, as the reading does');
			assert.ok(Math.abs(r.expectation - 4.5) < 1e-9,
				'the expectation must use the mass of every grade, not only the top one');
			assert.ok(/A\. 1\nB\. 2\nC\. 3\nD\. 4\nE\. 5$/.test(fake.requests[0].body.messages[0].content));
		} finally { await fake.close(); }
	});

	test('a description CHANGES the menu line, and the returned `choice` stays the CODE', async () => {
		const fake = await startFake(() => strongA() );
		try {
			const r = await clientOn(fake).decide({ state: 'S', question: 'q', theta: 0,
				options: [{ id: 'SAME', description: 'one and the same entity' }, { id: 'OTHER', description: 'two entities' }] });
			assert.ok(/A\. SAME: one and the same entity\nB\. OTHER: two entities$/
				.test(fake.requests[0].body.messages[0].content));
			assert.strictEqual(r.choice, 'SAME', 'the code comes back, not the rendered line');
		} finally { await fake.close(); }
	});

	test('`decideMany` asks N questions on ONE state, sequentially by default, and keeps the ids', async () => {
		const fake = await startFake(( body, req, n ) => chatResponse(lp(n === 1 ? [['A', 0.9], ['B', 0.1]] : [['B', 0.9], ['A', 0.1]])) );
		try {
			const rs = await clientOn(fake).decideMany('S\n', [
				{ id: 'q1', question: 'verdict', options: ['SAME', 'OTHER'], theta: 0 },
				{ id: 'q2', question: 'englobe', options: ['A', 'B', 'EQUAL'], theta: 0 },
			]);
			assert.deepStrictEqual(rs.map(( r ) => r.id ), ['q1', 'q2']);
			assert.deepStrictEqual(rs.map(( r ) => r.choice ), ['SAME', 'B']);
			assert.strictEqual(fake.requests.length, 2, 'one request per question: that is what makes each one one token');
			const states = fake.requests.map(( r ) => r.body.messages[0].content.split('Question:')[0] );
			assert.strictEqual(states[0], states[1],
				'the shared state must be byte-identical across the batch — that is what the server prefix cache needs');
		} finally { await fake.close(); }
	});

	test('the `/v1/completions` response shape is read too', async () => {
		const fake = await startFake(() => completionsResponse(lp([['A', 0.8], ['B', 0.2]])) );
		try {
			const r = await clientOn(fake).decide({ state: 'S', question: 'q', options: ['SAME', 'OTHER'], theta: 0 });
			assert.strictEqual(r.choice, 'SAME');
			assert.ok(Math.abs(r.p1 - 0.8) < 1e-9);
		} finally { await fake.close(); }
	});
});

describe('client — the failures, NAMED', () => {

	test('a 500 is retried, then RAISED with its status and its body', async () => {
		let n = 0;
		const fake = await startFake(() => { n++; return { status: 500, text: 'engine exploded' }; });
		try {
			const jev = clientOn(fake, { retries: 2, retryDelayMs: 1 });
			await assert.rejects(() => jev.decide({ state: 'S', question: 'q', options: ['A', 'B'] }),
				( e ) => e.code === 'NOTJEV_HTTP' && e.status === 500 && /engine exploded/.test(e.message));
			assert.strictEqual(n, 3, 'a 500 must be retried `retries` times, no more, no less');
		} finally { await fake.close(); }
	});

	test('NEGATIVE CONTROL — a 400 is NOT retried: retrying a malformed body hides it behind three refusals', async () => {
		let n = 0;
		const fake = await startFake(() => { n++; return { status: 400, text: 'bad request' }; });
		try {
			await assert.rejects(() => clientOn(fake, { retries: 3, retryDelayMs: 1 })
				.decide({ state: 'S', question: 'q', options: ['A', 'B'] }),
			( e ) => e.code === 'NOTJEV_HTTP' && e.status === 400);
			assert.strictEqual(n, 1, 'a 400 was retried ' + n + ' times — the same refusal three times over');
		} finally { await fake.close(); }
	});

	test('a server that hangs is cut at `timeoutMs` and NAMED `NOTJEV_TIMEOUT`', async () => {
		const fake = await startFake(() => ({ delayMs: 500, json: strongA() }) );
		try {
			await assert.rejects(() => clientOn(fake, { timeoutMs: 60, retries: 0 })
				.decide({ state: 'S', question: 'q', options: ['A', 'B'] }),
			( e ) => e.code === 'NOTJEV_TIMEOUT' && /60 ms/.test(e.message));
		} finally { await fake.close(); }
	});

	test('a 200 that is not JSON is NAMED `NOTJEV_BAD_RESPONSE`, not parsed into an empty distribution', async () => {
		const fake = await startFake(() => ({ status: 200, text: '<html>proxy</html>' }) );
		try {
			await assert.rejects(() => clientOn(fake).decide({ state: 'S', question: 'q', options: ['A', 'B'] }),
				( e ) => e.code === 'NOTJEV_BAD_RESPONSE' && /not JSON/.test(e.message));
		} finally { await fake.close(); }
	});

	test('an unreachable server is NAMED `NOTJEV_NETWORK` with the URL', async () => {
		const jev = createClient({ baseUrl: 'http://127.0.0.1:1', model: 'm', retries: 0, env: {} });
		await assert.rejects(() => jev.decide({ state: 'S', question: 'q', options: ['A', 'B'] }),
			( e ) => e.code === 'NOTJEV_NETWORK' && /127\.0\.0\.1:1/.test(e.message));
	});

	test('a missing baseUrl, a missing form and a broken codomain are REFUSED before any call', () => {
		assert.throws(() => createClient({ env: {} }), ( e ) => e.code === 'NOTJEV_NO_BASE_URL');
		const jev = createClient({ baseUrl: 'http://127.0.0.1:1', env: {} });
		assert.throws(() => jev.prompt({ state: 'S', question: 'q' }), ( e ) => e.code === 'NOTJEV_NO_FORM');
		assert.throws(() => jev.prompt({ state: 'S', question: 'q', options: ['X', 'X'] }), /DOUBLE/);
		assert.throws(() => jev.prompt({ state: 'S', question: 'q', options: ['A'] }), /at least 2 options/);
	});

	test('`decideMany` with `onError: collect` returns the failure IN PLACE, it does not drop the row', async () => {
		let n = 0;
		const fake = await startFake(() => { n++; return n === 2 ? { status: 400, text: 'no' } : strongA(); });
		try {
			const rs = await clientOn(fake).decideMany('S', [
				{ id: 'a', question: 'q', options: ['A', 'B'], theta: 0 },
				{ id: 'b', question: 'q', options: ['A', 'B'], theta: 0 },
				{ id: 'c', question: 'q', options: ['A', 'B'], theta: 0 },
			], { onError: 'collect' });
			assert.strictEqual(rs.length, 3, 'a failing row must keep its slot: a shorter array would silently '
				+ 'realign the answers with the wrong questions');
			assert.strictEqual(rs[1].ok, false);
			assert.strictEqual(rs[1].code, 'NOTJEV_HTTP');
			assert.strictEqual(rs[1].choice, null);
			assert.strictEqual(rs[2].choice, 'A');
		} finally { await fake.close(); }
	});
});

describe('client — the body, and what the caller can change about it', () => {

	test('the API key travels as a bearer, and extra headers are kept', async () => {
		const fake = await startFake(() => strongA() );
		try {
			await clientOn(fake, { apiKey: 'sk-test', headers: { 'X-Tenant': 'z' } })
				.decide({ state: 'S', question: 'q', options: ['A', 'B'], theta: 0 });
			assert.strictEqual(fake.requests[0].headers.authorization, 'Bearer sk-test');
			assert.strictEqual(fake.requests[0].headers['x-tenant'], 'z');
		} finally { await fake.close(); }
	});

	test('`templateKwargs: null` REMOVES the thinking switch (servers that reject unknown fields), and '
		+ '`extra` is merged last', async () => {
		const fake = await startFake(() => strongA() );
		try {
			const jev = clientOn(fake, { templateKwargs: null, extra: { user: 'u1' } });
			await jev.decide({ state: 'S', question: 'q', options: ['A', 'B'], theta: 0 });
			assert.strictEqual('chat_template_kwargs' in fake.requests[0].body, false,
				'the field is still in the body — OpenAI answers 400 on an unknown body field');
			assert.strictEqual(fake.requests[0].body.user, 'u1');
			const jev2 = clientOn(fake);
			await jev2.decide({ state: 'S', question: 'q', options: ['A', 'B'], theta: 0 });
			assert.deepStrictEqual(fake.requests[1].body.chat_template_kwargs, { enable_thinking: false },
				'by default the measured body must be sent unchanged');
		} finally { await fake.close(); }
	});

	test('`instruction` and `system` change the string, and `prompt()` shows it WITHOUT calling', async () => {
		const jev = createClient({ baseUrl: 'http://127.0.0.1:1', model: 'm', env: {} });
		const p = jev.prompt({ state: 'S\n', question: 'q', options: ['A', 'B'], instruction: 'Pick one letter.' });
		assert.ok(p.startsWith('Pick one letter.\n\nContext:\nS\n'));
		const b = jev.body({ state: 'S', question: 'q', options: ['A', 'B'], system: 'you are terse' });
		assert.strictEqual(b.params.messages[0].role, 'system');
		assert.strictEqual(b.params.messages.length, 2);
	});

	test('env vars are read when nothing is passed (NOTJEV_BASE_URL / MODEL / THETA / API_KEY)', () => {
		const jev = createClient({ env: { NOTJEV_BASE_URL: 'http://h:1/', NOTJEV_MODEL: 'M',
			NOTJEV_THETA: '0.8', NOTJEV_API_KEY: 'k' } });
		assert.strictEqual(jev.baseUrl, 'http://h:1', 'the trailing slash must be trimmed, or the path doubles it');
		assert.strictEqual(jev.model, 'M');
		assert.strictEqual(jev.theta, 0.8);
	});
});
