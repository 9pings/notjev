'use strict';
/**
 * context-http.js — L'ADAPTATEUR DU CLIENT HTTP EXISTANT.
 *
 * Le contrat : la capture part VERBATIM (rôles, morceaux multimodaux, historique d'outils), la
 * question vient en DERNIER tour utilisateur, la décision est un tour de UN token sans streaming,
 * les outils du contexte voyagent mais neutralisés (tool_choice none), et le cache amont se
 * RAPPORTE sans jamais se deviner.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { createHttpContextBackend } = require('../lib/context-http');
const { startFake, chatResponse, lp } = require('./helpers/fake-server');

const strongA = () => chatResponse(lp([['A', 0.95], ['B', 0.04], ['The', 0.01]]));

describe('context-http — la requête part avec le contexte VERBATIM', () => {
	test('messages conservés, question en dernier tour, décision = 1 token, pas de stream', async () => {
		const fake = await startFake(() => strongA());
		const backend = createHttpContextBackend({ baseUrl: fake.url, model: 'fake-model' });
		const parts = [{ type: 'text', text: 'Regarde.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }];
		const tools = [{ type: 'function', function: { name: 'f', description: 'd' } }];
		const context = { type: 'messages', model: 'fake-model', tools,
			messages: [
				{ role: 'system', content: 'sois bref.' },
				{ role: 'user', content: parts },
				{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
				{ role: 'tool', tool_call_id: 'c1', content: '42' },
			] };
		const r = await backend.decideContext({ context,
			question: { id: 'q', question: 'Quel mot de code ?', options: ['ORANGE', 'BLUE'] } });
		const body = fake.requests[0].body;
		assert.deepEqual(body.messages.slice(0, 4), context.messages, 'la capture part octet pour octet');
		assert.equal(body.messages.length, 5);
		assert.equal(body.messages[4].role, 'user');
		assert.match(body.messages[4].content, /Quel mot de code \?/);
		assert.match(body.messages[4].content, /ORANGE/);
		assert.equal(body.max_tokens, 1);
		assert.equal(body.logprobs, true);
		assert.equal(body.stream, false);
		assert.deepEqual(body.tools, tools);
		assert.equal(body.tool_choice, 'none');
		assert.equal(r.choice, 'ORANGE');
		await fake.close();
	});

	test('templateKwargs du contexte : objet remplacé, false retiré, absent = défaut du client', async () => {
		const fake = await startFake(() => strongA());
		const backend = createHttpContextBackend({ baseUrl: fake.url, model: 'fake-model' });
		const question = { id: 'q', question: 'q ?', options: ['ORANGE', 'BLUE'] };
		await backend.decideContext({ context: { type: 'fresh', messages: [], templateKwargs: { effort: 'low' } }, question });
		assert.deepEqual(fake.requests[0].body.chat_template_kwargs, { effort: 'low' });
		await backend.decideContext({ context: { type: 'fresh', messages: [], templateKwargs: false }, question });
		assert.equal('chat_template_kwargs' in fake.requests[1].body, false, 'false retire le champ');
		await backend.decideContext({ context: { type: 'fresh', messages: [] }, question });
		assert.deepEqual(fake.requests[2].body.chat_template_kwargs, { enable_thinking: false }, 'défaut préservé');
		await fake.close();
	});

	test('le cache amont se RAPPORTE (ou s\'avoue inconnu), jamais deviné', async () => {
		const fake = await startFake(( body, req, n ) => n === 1
			? chatResponse(lp([['A', 0.95], ['B', 0.04]]), { usage: { prompt_tokens: 10, completion_tokens: 1,
				prompt_tokens_details: { cached_tokens: 7 } } })
			: strongA());
		const backend = createHttpContextBackend({ baseUrl: fake.url, model: 'fake-model' });
		const question = { id: 'q', question: 'q ?', options: ['ORANGE', 'BLUE'] };
		const r1 = await backend.decideContext({ context: { type: 'fresh', messages: [] }, question });
		assert.deepEqual(r1.cache, { status: 'reported', cachedTokens: 7 });
		const r2 = await backend.decideContext({ context: { type: 'fresh', messages: [] }, question });
		assert.equal(r2.cache.status, 'unknown');
		await fake.close();
	});

	test('un snapshot pris pour un AUTRE modèle est refusé avant le premier octet réseau', async () => {
		const fake = await startFake(() => strongA());
		const backend = createHttpContextBackend({ baseUrl: fake.url, model: 'fake-model' });
		await assert.rejects(() => backend.decideContext({
			context: { type: 'messages', model: 'un-autre', messages: [] },
			question: { id: 'q', question: 'q ?', options: ['ORANGE', 'BLUE'] } }), { code: 'NOTJEV_MODEL_MISMATCH' });
		assert.equal(fake.requests.length, 0);
		await fake.close();
	});
});
