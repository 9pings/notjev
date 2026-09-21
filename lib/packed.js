'use strict';
/**
 * packed.js — PLUSIEURS QUESTIONS SUR UN ÉTAT, UNE PASSE.
 *
 * Forme mesurée (accord à l'oracle 0,911 contre 0,900 en séquentiel, ~2,2× moins cher, 21/09) : des
 * tours ALTERNÉS, chaque tour assistant portant un PLACEHOLDER fixe (`_`) — jamais la réponse du
 * modèle ; on lit `prompt_logprobs` à l'index du placeholder : la distribution qui a PRÉDIT ce token
 * EST la réponse à la question du tour qui précède.
 *
 * Le premier essai (toutes les questions concaténées dans un seul tour) était un artefact et a été
 * retiré : `/v1/completions` ne rend qu'une position générée, celle de la DERNIÈRE question. Sans
 * slot de réponse par question, il n'y a rien à lire — piège FORMAT/CONTRAT payé une fois.
 *
 * Les positions sont trouvées par tokenisation INCRÉMENTALE puis VÉRIFIÉES sur la tokenisation
 * complète : un désalignement refuse (`PACKED_MISALIGNED`), il ne compte pas. Un readout qui lit une
 * position décalée d'un token rend une distribution parfaitement plausible et parfaitement fausse.
 */
const readout = require('./readout');
const chatml = require('./chatml');
const { fail } = require('./errors');
const { formOf } = require('./client');

/** Le corps du tour utilisateur : l'état n'est écrit que dans le PREMIER (une passe, un état). */
function turnOf( q, state, first ) {
	return readout.renderTurn({
		state      : first ? state : undefined,
		question   : q.question,
		options    : q.form.texts,
		instruction: q.instruction,
	});
}

/**
 * LE PROMPT PACKED et ses positions de lecture.
 *
 * @param o `{ state, questions:[{ id, question, options|noul|score, instruction? }], tokenize, placeholder='_' }`
 * @returns `{ prompt, positions, slots, nTokens, placeholder }`
 */
async function buildPacked( o ) {
	const tokenize = o && o.tokenize;
	const placeholder = (o && o.placeholder) || '_';
	if ( typeof tokenize !== 'function' )
		throw fail('PACKED_NO_TOKENIZER', 'PACKED_NO_TOKENIZER — packed: `tokenize` est requis pour placer '
			+ 'les positions de lecture ; sans tokeniseur, la position lue serait une supposition.');
	const qs = ((o && o.questions) || []).map(( q, i ) =>
		Object.assign({}, q, { id: q.id === undefined ? i : q.id, form: formOf(q) }) );
	const ph = await tokenize(placeholder);
	if ( ph.length !== 1 )
		throw fail('PACKED_MISALIGNED', 'PACKED_MISALIGNED — packed: le placeholder '
			+ JSON.stringify(placeholder) + ' tokenise en ' + ph.length + ' token(s), il en faut UN.', { tokens: ph });
	let text = '';
	const positions = [], slots = [];
	for ( let i = 0; i < qs.length; i++ ) {
		text += chatml.render(
			[{ role: 'user', content: turnOf(qs[i], o.state, i === 0) }, { role: 'assistant', content: null }],
			{ thinkingOff: true });
		positions.push((await tokenize(text)).length);
		text += placeholder + '<|im_end|>\n';
		slots.push({
			id      : qs[i].id,
			letters : readout.lettersOf(qs[i].form.ids),
			options : qs[i].form.ids,
			form    : qs[i].form,
			question: qs[i].question,
		});
	}
	const ids = await tokenize(text);
	const bad = positions.filter(( p ) => p >= ids.length || ids[p] !== ph[0] );
	if ( bad.length )
		throw fail('PACKED_MISALIGNED', 'PACKED_MISALIGNED — packed: ' + bad.length + ' position(s) de lecture '
			+ 'ne tombent pas sur le placeholder — ne pas scorer.', { bad, nTokens: ids.length });
	return { prompt: text, positions, slots, nTokens: ids.length, placeholder };
}

/**
 * vLLM : `choices[0].prompt_logprobs[pos]` = `{ tokenId: { logprob, rank, decoded_token } }`.
 * Un élément par position du prompt (le premier est `null` : rien ne précède le premier token).
 */
function entriesAt( pl, pos ) {
	const d = pl[pos];
	if ( !d ) return null;
	return Object.keys(d).map(( k ) => ({
		token  : String(d[k].decoded_token),
		logprob: Number(d[k].logprob),
		rank   : d[k].rank,
		id     : Number(k),
	}) );
}

/**
 * LA LECTURE — une décision par question, même forme que `client.readResponse` (+ `id`, `position`).
 *
 * @param resp la réponse `/v1/completions` avec `prompt_logprobs`.
 * @param packed ce que `buildPacked` a rendu.
 * @param opts `{ theta?, edges? }`
 */
function readPacked( resp, packed, opts ) {
	const ch = resp && resp.choices && resp.choices[0];
	const pl = ch && ch.prompt_logprobs;
	if ( !Array.isArray(pl) )
		throw fail('PROMPT_LOGPROBS_ABSENT', 'PROMPT_LOGPROBS_ABSENT — packed: le serveur n\'a pas rendu '
			+ '`prompt_logprobs` ; sans distribution aux positions, il n\'y a pas de lecture — et l\'uniforme '
			+ 'silencieux se lirait comme une hésitation.');
	const theta = (opts && opts.theta !== undefined && opts.theta !== null) ? Number(opts.theta) : readout.THETA_DEFAULT;
	return packed.slots.map(( s, i ) => {
		const pos = packed.positions[i];
		const entries = entriesAt(pl, pos) || [];
		const dist = readout.distribution(entries, s.letters);
		const v = readout.decide({ probabilities: dist.probabilities, options: s.options, theta, edges: opts && opts.edges });
		const undecided = v.undecided || dist.degraded;
		return Object.assign({}, v, {
			id           : s.id,
			question     : s.question,
			position     : pos,
			ok           : !dist.degraded,
			choice       : undecided ? null : v.choice,
			index        : undecided ? -1 : v.index,
			value        : undecided ? null : s.form.decode(v.top),
			undecided    : undecided,
			coverage     : dist.coverage,
			exactMass    : dist.exactMass,
			spacedMass   : dist.spacedMass,
			degraded     : dist.degraded,
			probabilities: dist.probabilities,
			mass         : dist.mass,
			entries      : entries,
			kind         : s.form.kind,
			options      : s.options,
			letters      : s.letters,
			topToken     : entries.find(( e ) => e.rank === 1 ) || null,
			backend      : 'packed',
		});
	});
}

/**
 * LE COMPTEUR D'ÉCART separate ↔ packed, apparié par `id` et ventilé par BANDE.
 * Mesuré 3,3 % sur les coordonnées (6-9 % publié par les clones) : l'écart se concentre hors des
 * hautes bandes, c'est ce que le `byBand` rend lisible — un taux global le cacherait.
 */
function divergence( a, b ) {
	const byId = new Map((b || []).map(( r ) => [String(r.id), r] ));
	const byBand = {};
	let n = 0, differ = 0;
	for ( const r of (a || []) ) {
		const o = byId.get(String(r.id));
		if ( !o ) continue;
		n++;
		const band = r.band || 'n/a';
		byBand[band] = byBand[band] || { n: 0, differ: 0 };
		byBand[band].n++;
		if ( r.top !== o.top ) { differ++; byBand[band].differ++; }
	}
	return { n, differ, rate: n ? differ / n : 0, byBand };
}

/**
 * LE CLIENT PACKED — `baseUrl` doit finir par `/v1` (POST `<base>/completions`), comme le client vLLM
 * du cœur. `tokenize` est injecté : c'est le tokeniseur DU SERVEUR qui place les positions.
 */
function createPackedClient( o ) {
	const f = (o && o.fetch) || globalThis.fetch;
	const base = String((o && o.baseUrl) || '').replace(/\/$/, '');
	return {
		async decidePacked( state, questions, opts ) {
			const packed = await buildPacked({ state, questions, tokenize: o.tokenize, placeholder: o.placeholder });
			const t0 = Date.now();
			const body = {
				model: o.model, prompt: packed.prompt, max_tokens: 1, temperature: 0,
				prompt_logprobs: o.k === undefined ? 20 : o.k,
			};
			const r = await f(base + '/completions', {
				method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
			});
			if ( !r.ok ) throw fail('NOTJEV_HTTP', 'NOTJEV_HTTP — packed: ' + base + '/completions → ' + r.status);
			const rows = readPacked(await r.json(), packed, {
				theta: (opts && opts.theta !== undefined) ? opts.theta : o.theta,
				edges: (opts && opts.edges) || o.edges,
			});
			return { rows, packed, ms: Date.now() - t0, nTokens: packed.nTokens };
		},
		buildPacked: ( state, questions ) => buildPacked({ state, questions, tokenize: o.tokenize, placeholder: o.placeholder }),
	};
}

module.exports = { buildPacked, readPacked, divergence, createPackedClient, entriesAt };
