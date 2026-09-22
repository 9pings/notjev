'use strict';
/**
 * gateway.js — LE PROXY Chat Completions ET SES ROUTES DE CONTRÔLE.
 *
 * Le gateway promet : `current` devient une capture immuable de LA requête qui porte l'appel
 * (jamais un mélange entre deux), les autres contextes ne sont jamais réécrits, le SSE fragmenté
 * (nom coupé, arguments coupés, Unicode) est réassemblé avant d'être réémis, et un flux qui
 * s'interrompt au milieu d'un appel d'outil est une ERREUR, pas un appel silencieusement amputé.
 * Chaque test ferme ses serveurs par t.after, même quand une assertion échoue en cours de route.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { createGateway } = require('../lib/gateway');
const { createDecisionService } = require('../lib/service');
const { startFake } = require('./helpers/fake-server');

function fakeBackend() {
	return {
		model: 'fake-model',
		async decideContext() { return { choice: 'ORANGE', value: 'ORANGE', p1: 0.9, margin: 0.8, coverage: 0.99, ms: 1 }; },
	};
}

async function startGateway( t, options = {} ) {
	const upstream = await startFake(options.upstream || (() => ({ json: {} })));
	const service = options.service || createDecisionService({ backend: fakeBackend() });
	const server = createGateway(Object.assign({ service, baseUrl: upstream.url }, options.gateway || {}));
	await new Promise(( r ) => server.listen(0, '127.0.0.1', r));
	const url = 'http://127.0.0.1:' + server.address().port;
	t.after(async () => {
		server.closeAllConnections && server.closeAllConnections();
		await new Promise(( r ) => server.close(r));
		await upstream.close();
		await service.close();
	});
	return { url, upstream, service };
}

const QUESTION = { id: 'code', question: 'Quel mot de code ?', options: ['ORANGE', 'BLUE'] };
const CURRENT_ARGS = () => ({ context: { type: 'current' }, questions: [QUESTION] });
const JSON_HEADERS = { 'content-type': 'application/json' };
const post = ( url, body, headers ) => fetch(url, { method: 'POST',
	headers: Object.assign({}, JSON_HEADERS, headers || {}), body: JSON.stringify(body) });

describe('gateway — routes de contrôle', () => {
	test('/health répond SANS jeton ; le reste exige le jeton posé', async ( t ) => {
		const g = await startGateway(t, { gateway: { apiKey: 'sekret' } });
		const health = await fetch(g.url + '/health');
		assert.equal(health.status, 200);
		assert.deepEqual(await health.json(), { ok: true });
		const no = await post(g.url + '/notjev/decide', { questions: [QUESTION] });
		assert.equal(no.status, 401);
		assert.equal((await no.json()).error.code, 'NOTJEV_UNAUTHORIZED');
		const ok = await post(g.url + '/notjev/decide', { questions: [QUESTION] }, { authorization: 'Bearer sekret' });
		assert.equal(ok.status, 200);
		assert.equal((await ok.json()).results[0].choice, 'ORANGE');
	});

	test('put/drop/decide par HTTP ; route inconnue = 404 nommé ; JSON cassé = 400', async ( t ) => {
		const g = await startGateway(t);
		const put = await (await post(g.url + '/notjev/context/put', { state: 'ORANGE.' })).json();
		assert.match(put.ref, /^ctx_/);
		const decide = await (await post(g.url + '/notjev/decide',
			{ context: { type: 'snapshot', ref: put.ref }, questions: [QUESTION] })).json();
		assert.equal(decide.contextRef, put.ref);
		const drop = await (await post(g.url + '/notjev/context/drop', { ref: put.ref })).json();
		assert.deepEqual(drop, { dropped: true });
		const nowhere = await fetch(g.url + '/notjev/rien');
		assert.equal(nowhere.status, 404);
		assert.equal((await nowhere.json()).error.code, 'NOTJEV_NO_ROUTE');
		const broken = await fetch(g.url + '/notjev/decide', { method: 'POST', headers: JSON_HEADERS, body: '{pas json' });
		assert.equal(broken.status, 400);
		assert.equal((await broken.json()).error.code, 'NOTJEV_BAD_JSON');
	});

	test('corps borné : 413 AVANT de parler à l\'amont ou au backend', async ( t ) => {
		const g = await startGateway(t, { gateway: { bodyLimit: 2048 } });
		const big = await fetch(g.url + '/notjev/decide', { method: 'POST', headers: JSON_HEADERS,
			body: JSON.stringify({ questions: [QUESTION] }).padEnd(5000, ' ') });
		assert.equal(big.status, 413);
		assert.equal((await big.json()).error.code, 'NOTJEV_BODY_LIMIT');
		assert.equal(g.upstream.requests.length, 0);
	});
});

describe('gateway — le proxy JSON : current devient une capture de CETTE requête', () => {
	const upstreamReply = ( toolCall ) => ({ json: { model: 'fake-model', choices: [{ index: 0, finish_reason: 'tool_calls',
		message: { role: 'assistant', content: null, tool_calls: [toolCall] } }] } });

	test('current est capturé et référencé ; l\'amont reçoit le reste VERBATIM', async ( t ) => {
		const call = { id: 'call_1', type: 'function', function: { name: 'notjev_decide', arguments: JSON.stringify(CURRENT_ARGS()) } };
		const g = await startGateway(t, { upstream: () => upstreamReply(call) });
		const body = { model: 'fake-model', messages: [{ role: 'user', content: 'Quel mot de code ?' }], tools: [] };
		const r = await (await post(g.url + '/v1/chat/completions', body)).json();
		const bound = r.choices[0].message.tool_calls[0];
		assert.equal(bound.id, 'call_1');
		const args = JSON.parse(bound.function.arguments);
		assert.equal(args.context.type, 'snapshot');
		const snap = await g.service.store.acquire(args.context.ref);
		assert.deepEqual(snap.data.messages, body.messages, 'la capture est LA requête, pas une autre');
		snap.release();
		assert.equal(g.upstream.requests.length, 1);
		assert.deepEqual(g.upstream.requests[0].body, body, 'rien d\'autre n\'est réécrit');
	});

	test('fresh/snapshot jamais réécrits ; --tool-name capture le nom préfixé du CLI', async ( t ) => {
		const call = ( name, context ) => ({ id: 'call_1', type: 'function',
			function: { name, arguments: JSON.stringify({ context, questions: [QUESTION] }) } });
		const g = await startGateway(t, { gateway: { toolName: 'cli_notjev_decide' },
			upstream: () => upstreamReply(call('cli_notjev_decide', { type: 'current' })) });
		const r = await (await post(g.url + '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] })).json();
		assert.equal(JSON.parse(r.choices[0].message.tool_calls[0].function.arguments).context.type, 'snapshot');

		const g2 = await startGateway(t, { gateway: { toolName: 'cli_notjev_decide' }, upstream: () => upstreamReply(call('notjev_decide', { type: 'current' })) });
		const r2 = await (await post(g2.url + '/v1/chat/completions', { messages: [] })).json();
		const c2 = r2.choices[0].message.tool_calls[0].function;
		assert.equal(c2.name, 'notjev_decide');
		assert.deepEqual(JSON.parse(c2.arguments).context, { type: 'current' },
			'sans --tool-name, current reste tel quel : le client verra le refus nommé du service');

		const g3 = await startGateway(t, { upstream: () => upstreamReply(call('notjev_decide', { type: 'fresh', state: 'x' })) });
		const r3 = await (await post(g3.url + '/v1/chat/completions', { messages: [] })).json();
		assert.equal(JSON.parse(r3.choices[0].message.tool_calls[0].function.arguments).context.state, 'x');
		assert.equal(g3.service.store.stats().entries, 0, 'aucune capture pour un contexte explicite');
	});

	test('current avec un autre champ est refusé ; l\'échec amont est nommé', async ( t ) => {
		const call = { id: 'call_1', type: 'function',
			function: { name: 'notjev_decide', arguments: JSON.stringify({ context: { type: 'current', ref: 'x' }, questions: [QUESTION] }) } };
		const g = await startGateway(t, { upstream: () => upstreamReply(call) });
		const r = await post(g.url + '/v1/chat/completions', { messages: [] });
		assert.equal(r.status, 400);
		assert.equal((await r.json()).error.code, 'NOTJEV_BAD_CONTEXT');
		const g2 = await startGateway(t, { upstream: () => ({ status: 503, json: { error: 'overloaded' } }) });
		const r2 = await post(g2.url + '/v1/chat/completions', { messages: [] });
		assert.equal(r2.status, 503);
		assert.equal((await r2.json()).error.code, 'NOTJEV_UPSTREAM');
	});
});

describe('gateway — le proxy SSE : fragments réassemblés, puis liés', () => {
	const sse = ( events ) => events.map(( e ) => 'data: ' + JSON.stringify(e)).join('\n\n')
		+ '\n\ndata: [DONE]\n\n';
	const sseUpstream = ( events ) => () => ({ text: sse(events), headers: { 'content-type': 'text/event-stream' } });

	/** Les data: de la réponse, dans l'ordre. */
	async function readSse( res ) {
		assert.equal(res.headers.get('content-type'), 'text/event-stream');
		const text = await res.text();
		return text.split('\n\n').filter(( l ) => l.startsWith('data: '))
			.map(( l ) => l.slice(6).trim());
	}

	test('nom coupé, arguments coupés, Unicode : réassemblés, liés, le texte relayé', async ( t ) => {
		const args = { context: { type: 'current' },
			questions: [{ id: 'é', question: 'Ça va ?', options: ['OUI', 'NON'] }] };
		const argString = JSON.stringify(args);
		const tc = ( name, part ) => ({ index: 0, ...(name !== undefined ? { id: 'call_1', type: 'function' } : {}),
			function: { ...(name !== undefined ? { name } : {}), arguments: part } });
		const events = [
			{ choices: [{ index: 0, delta: { role: 'assistant', content: 'Réponse' } }] },
			{ choices: [{ index: 0, delta: { tool_calls: [tc('notjev_de', argString.slice(0, 11))] } }] },
			{ choices: [{ index: 0, delta: { tool_calls: [tc('cide', argString.slice(11, 40))] } }] },
			{ choices: [{ index: 0, delta: { tool_calls: [tc(undefined, argString.slice(40))] } }] },
			{ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
		];
		const g = await startGateway(t, { upstream: sseUpstream(events) });
		const res = await post(g.url + '/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'x' }] });
		const out = await readSse(res);
		assert.equal(out.at(-1), '[DONE]');
		assert.deepEqual(JSON.parse(out[0]).choices[0].delta, { role: 'assistant', content: 'Réponse' }, 'le texte passe tel quel');
		for ( const line of out.slice(1, 4) ) assert.equal(JSON.parse(line).choices[0].delta.tool_calls, undefined,
			'les fragments bruts ne fuient jamais vers le client');
		const calls = JSON.parse(out.at(-2)).choices[0].delta.tool_calls;
		assert.equal(calls.length, 1);
		assert.equal(calls[0].function.name, 'notjev_decide');
		const bound = JSON.parse(calls[0].function.arguments);
		assert.equal(bound.context.type, 'snapshot');
		const snap = await g.service.store.acquire(bound.context.ref);
		assert.equal(snap.data.messages[0].content, 'x');
		snap.release();
	});

	test('deux appels, deux index : réassemblés séparément, triés par index, un seul lié', async ( t ) => {
		const mk = ( index, id, name, context ) => ({ index, id, type: 'function',
			function: { name, arguments: JSON.stringify({ context, questions: [QUESTION] }) } });
		const events = [
			{ choices: [{ index: 0, delta: { tool_calls: [mk(1, 'a', 'autre_outil', { type: 'fresh', state: 'y' })] } }] },
			{ choices: [{ index: 0, delta: { tool_calls: [mk(0, 'b', 'notjev_decide', { type: 'current' })] } }] },
			{ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
		];
		const g = await startGateway(t, { upstream: sseUpstream(events) });
		const res = await post(g.url + '/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'x' }] });
		const out = await readSse(res);
		const calls = JSON.parse(out.at(-2)).choices[0].delta.tool_calls;
		assert.equal(calls.length, 2);
		assert.equal(calls[0].id, 'b');
		assert.equal(calls[0].function.name, 'notjev_decide');
		assert.equal(JSON.parse(calls[0].function.arguments).context.type, 'snapshot');
		assert.equal(calls[1].id, 'a');
		assert.equal(calls[1].function.name, 'autre_outil', 'seuls les appels NotJev sont liés');
		assert.equal(JSON.parse(calls[1].function.arguments).context.state, 'y');
	});

	test('flux coupé au milieu d\'un appel : la connexion meurt, rien n\'est réémis', async ( t ) => {
		const events = [
			{ choices: [{ index: 0, delta: { content: 'Début' } }] },
			{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function',
			function: { name: 'notjev_decide', arguments: '{"questions":[' } }] } }] }];
		const g = await startGateway(t, { upstream: () => ({ text: sse(events), headers: { 'content-type': 'text/event-stream' } }) });
		await assert.rejects(async () => {
			const res = await post(g.url + '/v1/chat/completions', { stream: true, messages: [] });
			await res.text();
		}, ( e ) => e.code === 'ECONNRESET' || e.name === 'TypeError' || /terminated/.test(e.message));
	});
});
