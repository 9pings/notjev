'use strict';
/**
 * service.js — LE SERVICE DE DÉCISIONS, SANS TRANSPORT.
 *
 * Le service promet : un lot ENTIER validé AVANT la première inférence, un contexte figé par lot
 * (chaque question voit la même donnée), des erreurs PAR LIGNE sans arrêter le lot, une annulation
 * nommée, et une fermeture qui attend les vols en cours.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { createDecisionService } = require('../lib/service');

function fakeBackend( o = {} ) {
	const calls = [];
	let inFlight = 0, maxInFlight = 0, closed = false;
	const backend = {
		model: o.model || 'fake-model',
		calls,
		maxInFlight: () => maxInFlight,
		isClosed: () => closed,
		async decideContext({ context, question, signal }) {
			calls.push({ context: JSON.parse(JSON.stringify(context)), question, signal });
			inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
			try {
				if ( o.delayMs ) await new Promise(( resolve, reject ) => {
					const timer = setTimeout(done, o.delayMs);
					function done() { signal?.removeEventListener('abort', abort); resolve(); }
					function abort() { clearTimeout(timer); reject(signal.reason); }
					if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
				});
				signal?.throwIfAborted();
				if ( o.failFor && o.failFor.has(question.id) )
					throw Object.assign(new Error('backend boom for ' + question.id), { code: 'NOTJEV_X' });
				if ( o.mutate ) context.messages.push({ role: 'user', content: 'MUTÉ' });
				return { choice: 'ORANGE', value: 'ORANGE', p1: 0.9, margin: 0.8, coverage: 0.99, ms: 1 };
			} finally { inFlight--; }
		},
		async close() { closed = true; },
	};
	return backend;
}

const Q = ( id ) => ({ id, question: 'Quel mot de code ?', options: ['ORANGE', 'BLUE'] });

describe('service — validation AVANT calcul', () => {
	test('un lot invalide ne touche JAMAIS le backend', async () => {
		const backend = fakeBackend();
		const service = createDecisionService({ backend });
		const bad = [
			[{ rogueField: 1, questions: [Q('a')] }, /Unknown request field/],
			[{ questions: [] }, /1\.\.64/],
			[{ questions: [Q('a'), Q('a')] }, /unique/],
			[{ questions: [Object.assign(Q('a'), { rogue: 1 })] }, /Unknown question field/],
			[{ questions: [Object.assign(Q('a'), { options: ['X'], noul: true })] }, /exactly one/],
			[{ questions: [Object.assign(Q('a'), { theta: 2 })] }, /theta/],
			[{ questions: [Q('a')], execution: 'sequential' }, /independent/],
			[{ questions: [Q('a')], context: { type: 'snapshot', ref: 'ctx_x', extra: 1 } }, /only ref/],
		];
		for ( const [input, re] of bad ) await assert.rejects(() => service.decide(input), re);
		assert.equal(backend.calls.length, 0);
	});

	test('maxQuestions borne le lot avant la première inférence', async () => {
		const backend = fakeBackend();
		const service = createDecisionService({ backend, maxQuestions: 2 });
		await assert.rejects(() => service.decide({ questions: [Q('a'), Q('b'), Q('c')] }), /1\.\.2/);
		assert.equal(backend.calls.length, 0);
	});

	test('un SNAPSHOT inconnu est refusé sans inférence', async () => {
		const backend = fakeBackend();
		const service = createDecisionService({ backend });
		await assert.rejects(() => service.decide({ context: { type: 'snapshot', ref: 'ctx_manquant' }, questions: [Q('a')] }),
			{ code: 'NOTJEV_CONTEXT_UNAVAILABLE' });
		assert.equal(backend.calls.length, 0);
	});
});

describe('service — résultats', () => {
	test('erreur PAR LIGNE : une question qui échoue n\'arrête pas le lot', async () => {
		const backend = fakeBackend({ failFor: new Set(['b']) });
		const service = createDecisionService({ backend });
		const r = await service.decide({ questions: [Q('a'), Q('b'), Q('c')] });
		assert.equal(backend.calls.length, 3);
		assert.deepEqual(r.results.map(( x ) => x.status), ['decided', 'error', 'decided']);
		assert.equal(r.results[1].error.code, 'NOTJEV_X');
		assert.equal(r.results[0].choice, 'ORANGE');
		assert.equal(r.model, 'fake-model');
	});

	test('le contexte est FIGÉ PAR LOT : la mutation d\'une ligne ne pollue pas la suivante', async () => {
		const backend = fakeBackend({ mutate: true });
		const service = createDecisionService({ backend });
		const r = await service.decide({ context: { type: 'fresh', state: 'Le code est ORANGE.' }, questions: [Q('a'), Q('b')] });
		assert.equal(r.results.length, 2);
		assert.equal(backend.calls[0].context.messages.length, 1, 'la première ligne voit le contexte d\'origine');
		assert.equal(backend.calls[1].context.messages.length, 1, 'la mutation de la première ligne ne fuit pas dans la seconde');
	});

	test('un SNAPSHOT : référencé, libéré, et réutilisable ; le modèle doit coller au backend', async () => {
		const backend = fakeBackend();
		const service = createDecisionService({ backend });
		const { ref } = service.putContext({ type: 'messages', messages: [{ role: 'user', content: 'ORANGE.' }] });
		const r = await service.decide({ context: { type: 'snapshot', ref }, questions: [Q('a')] });
		assert.equal(r.contextRef, ref);
		assert.equal(backend.calls[0].context.messages[0].content, 'ORANGE.');
		await service.decide({ context: { type: 'snapshot', ref }, questions: [Q('a')] });
		const other = service.putContext({ type: 'messages', messages: [], model: 'un-autre-modele' });
		await assert.rejects(() => service.decide({ context: { type: 'snapshot', ref: other.ref }, questions: [Q('a')] }),
			{ code: 'NOTJEV_MODEL_MISMATCH' });
	});

	test('concurrency borne le parallélisme, jamais l\'ordre des lignes', async () => {
		const backend = fakeBackend({ delayMs: 20 });
		const service = createDecisionService({ backend, concurrency: 2 });
		const r = await service.decide({ questions: [Q('a'), Q('b'), Q('c'), Q('d')] });
		assert.equal(backend.maxInFlight(), 2);
		assert.deepEqual(r.results.map(( x ) => x.id), ['a', 'b', 'c', 'd']);
	});
});

describe('service — annulation et fermeture', () => {
	test('timeout : le lot rejette avec NOTJEV_TIMEOUT, les vols sont interrompus', async () => {
		const backend = fakeBackend({ delayMs: 500 });
		const service = createDecisionService({ backend, timeoutMs: 40 });
		await assert.rejects(() => service.decide({ questions: [Q('a')] }), { code: 'NOTJEV_TIMEOUT' });
	});

	test('signal externe : le lot rejette, abrégé — pas de résultat à moitié rempli', async () => {
		const backend = fakeBackend({ delayMs: 500 });
		const service = createDecisionService({ backend, timeoutMs: 10000 });
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 30);
		await assert.rejects(() => service.decide({ questions: [Q('a')] }, { signal: ac.signal }));
	});

	test('close() abrège les vols en cours (NOTJEV_CLOSED), vide le stock et ferme un backend possédé', async () => {
		const backend = fakeBackend({ delayMs: 500 });
		const service = createDecisionService({ backend, ownsBackend: true });
		const { ref } = service.putContext({ state: 'x' });
		const inFlight = service.decide({ context: { type: 'snapshot', ref }, questions: [Q('a')] });
		await new Promise(( r ) => setTimeout(r, 30));
		await service.close();
		await assert.rejects(() => inFlight, { code: 'NOTJEV_CLOSED' });
		assert.ok(backend.isClosed());
		assert.throws(() => service.putContext({ state: 'y' }), { code: 'NOTJEV_CLOSED' });
		await assert.rejects(() => service.decide({ questions: [Q('a')] }), { code: 'NOTJEV_CLOSED' });
	});
});
