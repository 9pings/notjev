'use strict';
/**
 * llama-server (ggml-org/llama.cpp) : `/completion` avec `n_probs` — la voie GGUF, celle qui a servi
 * les chiffres 8B et 27B GGUF de la campagne 20/09 (accord 0,935 contre 0,947 sur vLLM, 290 ms contre
 * 70 ms par question). Le PROMPT est le même octet pour octet que sur vLLM : seul le transport change.
 * C'est la raison d'être de `lib/chatml.js` — `/completion` ne connaît aucun gabarit, on le lui écrit.
 *
 * `cache_prompt: false` est délibéré : le préfixe partagé entre deux questions sur le même état ferait
 * varier le temps mesuré sans rien changer à la lecture, et un cache chaud a déjà rendu, dans le projet
 * source, des « mesures de latence » qui mesuraient le cache.
 *
 * Deux formes de `completion_probabilities` coexistent selon le build (b11060 a renommé) : les deux
 * sont lues. Une seule des deux, et un changement de build rendrait `[]` — l'uniforme, en silence.
 */
const readout = require('../readout');
const chatml = require('../chatml');
const { formOf, readResponse } = require('../client');
const { fail } = require('../errors');
const { makeHttpTokenizer } = require('../tokenizer');

/** `[{token, logprob}]` depuis l'une OU l'autre forme ; une absence rend `[]`, jamais `null`. */
function entriesOfLlamaServer( resp ) {
	const cp = resp && resp.completion_probabilities && resp.completion_probabilities[0];
	if ( !cp ) return [];
	if ( Array.isArray(cp.top_logprobs) )
		return cp.top_logprobs.map(( t ) => ({ token: String(t.token), logprob: Number(t.logprob) }) );
	if ( Array.isArray(cp.probs) )
		return cp.probs.map(( t ) => ({ token: String(t.tok_str), logprob: Math.log(Math.max(Number(t.prob), 1e-300)) }) );
	return [];
}

/** La réponse llama-server, remise dans la forme `chat/completions` que `readResponse` sait lire. */
function asChatResponse( resp ) {
	const entries = entriesOfLlamaServer(resp);
	return {
		choices: [{
			message : { role: 'assistant', content: resp && resp.content },
			logprobs: { content: [{ token: resp && resp.content, logprob: 0, top_logprobs: entries }] },
		}],
		usage  : { prompt_tokens: resp && resp.tokens_evaluated },
		model  : (resp && resp.model) || null,
	};
}

/**
 * @param o `{ baseUrl, nProbs=40, theta?, edges?, fetch?, thinkingOff=true, model? }`
 * @returns `{ decide, decideMany, noul, score, prompt, tokenize }` — même surface que `createClient`.
 */
function createLlamaServerClient( o ) {
	const f = (o && o.fetch) || globalThis.fetch;
	const base = String((o && o.baseUrl) || '').replace(/\/$/, '');
	const theta0 = o && o.theta;

	function prompt( q ) {
		const form = formOf(q);
		const content = readout.renderTurn({
			state: q.state, question: q.question, options: form.texts, instruction: q.instruction,
		});
		const turns = q.system ? [{ role: 'system', content: q.system }] : [];
		turns.push({ role: 'user', content }, { role: 'assistant', content: null });
		return { form, content, text: chatml.render(turns, { thinkingOff: o.thinkingOff !== false }) };
	}

	async function decide( q ) {
		const question = q || {};
		const p = prompt(question);
		const params = {
			prompt: p.text, n_predict: 1, n_probs: o.nProbs || 40, temperature: 0,
			cache_prompt: false, post_sampling_probs: false,
		};
		const t0 = Date.now();
		const r = await f(base + '/completion', {
			method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params),
		});
		if ( !r.ok ) throw fail('NOTJEV_HTTP', 'NOTJEV_HTTP — llama-server: ' + base + '/completion → ' + r.status);
		const out = readResponse(asChatResponse(await r.json()), {
			form : p.form,
			theta: question.theta !== undefined ? question.theta : theta0,
			edges: question.edges || o.edges,
			prompt: p.text, request: params, ms: Date.now() - t0, model: o.model,
		});
		out.backend = 'llama-server';
		out.source = 'http';
		return out;
	}

	async function decideMany( state, questions, opts ) {
		const qs = (questions || []).map(( q, i ) =>
			Object.assign({ id: q.id === undefined ? i : q.id }, q, { state: q.state === undefined ? state : q.state }) );
		const n = Math.max(1, (opts && opts.concurrency) || 1);
		const out = new Array(qs.length);
		let next = 0;
		await Promise.all(Array.from({ length: Math.min(n, qs.length) }, async () => {
			for ( ;; ) {
				const j = next++;
				if ( j >= qs.length ) return;
				const r = await decide(qs[j]);
				r.id = qs[j].id;
				r.question = qs[j].question;
				out[j] = r;
			}
		}));
		return out;
	}

	return {
		decide, decideMany,
		prompt: ( q ) => prompt(q).text,
		noul  : ( state, question, pair, more ) =>
			decide(Object.assign({}, more || {}, { state, question, noul: pair == null ? true : pair })),
		score : ( state, question, range, more ) =>
			decide(Object.assign({}, more || {}, { state, question, score: range == null ? { min: 1, max: 5 } : range })),
		tokenize: makeHttpTokenizer({ baseUrl: base, kind: 'llama-server', fetch: f }),
	};
}

module.exports = { createLlamaServerClient, entriesOfLlamaServer, asChatResponse };
