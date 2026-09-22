'use strict';
/**
 * context.js — LE STOCKAGE D'EXTRAITS : immuables, bornées, à périmètre et à durée de vie.
 *
 * Chaque test vise un contrat du commentaire de tête du module : une capture est un JSON figé
 * (jamais une référence vivante), un lecteur tient la donnée (lease), et les quotas se
 * débloquent par expiration, pas par exception silencieuse.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { createContextStore, normalizeContext } = require('../lib/context');

function storeOf( options, clock ) {
	return createContextStore(Object.assign({ clock }, options));
}

describe('context — normalisation', () => {
	test('fresh: state devient un tour utilisateur ; messages reste verbatim', () => {
		const a = normalizeContext({ type: 'fresh', state: 'Le code est ORANGE.' });
		assert.deepEqual(a, { type: 'fresh', messages: [{ role: 'user', content: 'Le code est ORANGE.' }] });
		const parts = [{ type: 'text', text: 'x' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }];
		const b = normalizeContext({ type: 'messages', messages: [{ role: 'user', content: parts }] });
		assert.deepEqual(b.messages[0].content, parts);
	});

	test('refus nommés : champ inconnu, state+messages, rôles, morceaux non multimodaux', () => {
		assert.throws(() => normalizeContext({ type: 'fresh', rogue: 1 }), /Unknown context field/);
		assert.throws(() => normalizeContext({ state: 'a', messages: [] }), /not both/);
		assert.throws(() => normalizeContext({ messages: [{ role: 'wizard', content: 'x' }] }), /role/);
		assert.throws(() => normalizeContext({ messages: [{ role: 'user', content: [{ type: 'audio', text: 'x' }] }] }), /content parts/);
		assert.throws(() => normalizeContext({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'ftp://x' } }] }] }), /content parts/);
		assert.throws(() => normalizeContext({ messages: [{ role: 'user', content: 42 }] }), /content parts/);
	});

	test('un échange d\'outils COMPLET passe ; tout déséquilibre est nommé', () => {
		const ok = [{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
			{ role: 'tool', tool_call_id: 'c1', content: '42' }];
		assert.doesNotThrow(() => normalizeContext({ type: 'messages', messages: ok }));
		assert.throws(() => normalizeContext({ type: 'messages', messages: ok.slice(0, 1) }), /unresolved tool calls/);
		assert.throws(() => normalizeContext({ type: 'messages', messages: ok.slice(1) }), /Unmatched tool result/);
		const dup = ok.concat([{ role: 'tool', tool_call_id: 'c1', content: 'x' }]);
		assert.throws(() => normalizeContext({ type: 'messages', messages: dup }), /Unmatched tool result/);
		assert.throws(() => normalizeContext({ type: 'messages', messages: [
			{ role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
			{ role: 'tool', tool_call_id: 'c1', content: '42' },
			{ role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] }] }), /duplicate tool call/);
		assert.throws(() => normalizeContext({ type: 'messages', messages: [
			{ role: 'user', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] }] }), /requires an assistant/);
	});

	test('model/tools/templateKwargs sont copiés ; templateKwargs accepte false et null', () => {
		const tools = [{ type: 'function', function: { name: 'f' } }];
		const a = normalizeContext({ type: 'fresh', state: 'x', model: 'm', tools, templateKwargs: { enable_thinking: false } });
		assert.equal(a.model, 'm');
		assert.deepEqual(a.tools, tools);
		assert.equal(normalizeContext({ state: 'x', templateKwargs: false }).templateKwargs, false);
		assert.throws(() => normalizeContext({ state: 'x', templateKwargs: [1] }), /templateKwargs/);
	});
});

describe('context — le stockage', () => {
	test('une capture est FIGÉE : muter l\'entrée ou la lecture ne change pas la suivante', () => {
		const store = storeOf();
		const input = { type: 'messages', messages: [{ role: 'user', content: 'ORANGE.' }] };
		const { ref } = store.put(input);
		input.messages[0].content = 'BLUE.';
		const first = store.acquire(ref);
		first.data.messages.push({ role: 'user', content: 'pollution' });
		first.data.messages[0].content = 'BLUE.';
		first.release();
		const second = store.acquire(ref);
		assert.deepEqual(second.data.messages, [{ role: 'user', content: 'ORANGE.' }]);
		second.release();
	});

	test('périmètre : une référence d\'un scope est invisible depuis l\'autre', () => {
		const store = storeOf();
		const { ref } = store.put({ state: 'x' }, 'tenantA');
		assert.throws(() => store.acquire(ref, 'tenantB'), { code: 'NOTJEV_CONTEXT_UNAVAILABLE' });
		assert.ok(store.acquire(ref, 'tenantA').release);
	});

	test('TTL : expirée = indisponible ; un lecteur en cours retient la donnée jusqu\'à sa libération', () => {
		let t = 0;
		const store = storeOf({ ttlMs: 1000 }, () => t);
		const { ref } = store.put({ state: 'x' });
		t = 999;
		const lease = store.acquire(ref);
		t = 1500;
		assert.throws(() => store.acquire(ref), { code: 'NOTJEV_CONTEXT_UNAVAILABLE' });
		assert.equal(store.stats().entries, 1, 'le lecteur en cours empêche le balayage');
		lease.release();
		assert.equal(store.stats().entries, 0, 'libéré, l\'entrée expirée disparaît');
		assert.throws(() => store.acquire(ref), { code: 'NOTJEV_CONTEXT_UNAVAILABLE' });
	});

	test('quotas : maxEntries et maxBytes refusent AVANT d\'écrire ; l\'expiration débloquent', () => {
		let t = 0;
		const store = storeOf({ maxEntries: 2, maxBytes: 4096, ttlMs: 100 }, () => t);
		store.put({ state: 'a' }); store.put({ state: 'b' });
		assert.throws(() => store.put({ state: 'c' }), { code: 'NOTJEV_CONTEXT_LIMIT' });
		t = 200;
		assert.doesNotThrow(() => store.put({ state: 'c' }), 'expirées, les entrées libèrent le quota');
		const small = storeOf({ maxBytes: 10 });
		assert.throws(() => small.put({ state: 'beaucoup plus de dix octets' }), { code: 'NOTJEV_CONTEXT_LIMIT' });
	});

	test('drop : invisible pour un NOUVEAU lecteur, tenue par le lecteur en cours, balayée ensuite', () => {
		let t = 0;
		const store = storeOf({ ttlMs: 10000 }, () => t);
		const { ref } = store.put({ state: 'x' });
		const lease = store.acquire(ref);
		store.drop(ref);
		assert.throws(() => store.acquire(ref), { code: 'NOTJEV_CONTEXT_UNAVAILABLE' });
		assert.equal(store.stats().entries, 1, 'tenue par le lecteur');
		lease.release();
		assert.equal(store.stats().entries, 0);
		store.clear();
		assert.deepEqual(store.stats(), { entries: 0, bytes: 0 });
	});

	test('les identifiants sont uniques et préfixés, les stats comptent les octets', () => {
		const store = storeOf();
		const a = store.put({ state: 'x' });
		const b = store.put({ state: 'x' });
		assert.match(a.ref, /^ctx_[0-9a-f-]{36}$/);
		assert.notEqual(a.ref, b.ref);
		assert.equal(store.stats().bytes, a.bytes + b.bytes);
	});
});
