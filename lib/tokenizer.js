'use strict';
/**
 * tokenizer.js — LES CONTRÔLES D'INSTRUMENT, avant tout chiffre.
 * Mesuré : 17 codes IPTC partagent le premier token `medtop:` → le régime « code direct » fusionnerait
 * 17 options en une masse ; une lettre qui n'est pas un token unique déplace la position lue. Ces
 * contrôles refusent, ils ne corrigent pas. `tokenize` est injecté : `/tokenize` d'un serveur, ou
 * node-llama-cpp.
 *
 * Convention d'erreur (owner 21/09) : le code est dans `e.code` ET en tête du message — une erreur de
 * contrat doit se nommer même quand on ne lit qu'une stack.
 */
const { fail } = require('./errors');

async function checkLetters( tokenize, letters ) {
	const ids = [];
	for ( const L of letters ) {
		const t = await tokenize(String(L));
		if ( t.length !== 1 ) throw fail('LETTER_NOT_ATOMIC', 'LETTER_NOT_ATOMIC — tokenizer: la lettre '
			+ JSON.stringify(L) + ' tokenise en ' + t.length
			+ ' token(s) : le régime lettre exige un token exact.', { letter: L, tokens: t });
		ids.push(t[0]);
	}
	if ( new Set(ids).size !== ids.length )
		throw fail('LETTER_NOT_ATOMIC', 'LETTER_NOT_ATOMIC — tokenizer: deux lettres partagent un id.', { ids });
	return { ids };
}

/**
 * `prompt` MUST be the TEMPLATED string — the one that actually goes to the server, with the assistant
 * turn open (`chatml.render([...,{role:'assistant',content:null}], {thinkingOff:true})`). Measured in
 * vivo (21/09, vLLM 0.28 / Qwen3.8-27B): on the bare user content the check REFUSES (`ANSWER_BOUNDARY`,
 * « AUTRE »+« A » glue into one token), on the templated prompt it passes. Checking the wrong string
 * would refuse a valid readout.
 */
async function checkBoundary( tokenize, prompt, letter ) {
	const base = await tokenize(String(prompt));
	const withL = await tokenize(String(prompt) + String(letter));
	const ok = withL.length === base.length + 1 && base.every(( id, i ) => id === withL[i] );
	if ( !ok ) throw fail('ANSWER_BOUNDARY', 'ANSWER_BOUNDARY — tokenizer: prompt+' + JSON.stringify(letter)
		+ ' ne tokenise pas en prompt ++ [token] : la frontière de réponse change la tokenisation.',
		{ base: base.length, withLetter: withL.length });
	return { id: withL[withL.length - 1] };
}

/**
 * L'INVENTAIRE DE LA FORME ESPACÉE — la surface ` A` de chaque lettre, AVANT de lire une couverture.
 *
 * Mesuré sur les vocabulaires tels que publiés (11 familles, A..S, les deux surfaces) : les familles
 * diffèrent SUR CE COMpte, pas sur un biais. Trois régimes existent, et chacun change ce que
 * `readout.distribution` peut voir :
 *   - `same`  : ` A` et `A` sont le MÊME token (SentencePiece, ex. Llama-2, Mistral v0.3) — un seul
 *               token d'ID par option, `spacedMass` est un zéro STRUCTUREL, pas un petit nombre ;
 *   - `single`: ` A` est un token distinct (Ġ-BPE, ex. Qwen3, Llama-3.1, GPT-2/NeoX) — deux tokens
 *               d'ID par option, `spacedMass` est une quantité réelle (mesurée <= 0,08 % de la
 *               couverture sur la campagne, famille à deux tokens) ;
 *   - `multi` : ` A` est PLUSIEURS tokens (ex. Phi-3 : espace nu puis lettre) — la forme espacée
 *               est ILLISIBLE à `max_tokens: 1` : un modèle qui la préfère émet l'espace d'abord,
 *               les lettres ne portent presque rien, et la couverture SOUS-COMPTE sa préférence.
 * L'inventaire se fait CONTRE LE SERVEUR déployé (`makeHttpTokenizer`) : c'est la pièce détokenisée
 * que renvoie le serveur qui choisit le seau dans `distribution`, pas le décodage HF.
 *
 * @param opts `{ strict? }` — `strict` REFUSE le régime `multi` (le défaut de ce module est de
 *        refuser, pas de corriger) ; sans `strict`, l'inventaire est rendu et le champ `multi`
 *        compte les lettres concernées.
 * @returns `{ forms: [{ letter, bare, spaced, regime }], counts: { same, single, multi } }`
 */
async function checkSpacedLetters( tokenize, letters, opts ) {
	const forms = [];
	for ( const L of (letters || []) ) {
		const bare = await tokenize(String(L));
		const spaced = await tokenize(' ' + String(L));
		const regime = spaced.length === 1
			? ((bare.length === 1 && spaced[0] === bare[0]) ? 'same' : 'single')
			: 'multi';
		forms.push({ letter: String(L), bare: bare, spaced: spaced, regime: regime });
	}
	const counts = { same: 0, single: 0, multi: 0 };
	for ( const f of forms ) counts[f.regime]++;
	if ( counts.multi && opts && opts.strict )
		throw fail('LETTER_SPACED_FRAGMENT', 'LETTER_SPACED_FRAGMENT — tokenizer: la forme espacée de '
			+ forms.filter(( f ) => f.regime === 'multi' ).map(( f ) => JSON.stringify(' ' + f.letter) ).join(', ')
			+ ' est MULTI-token : à max_tokens: 1 le readout ne lit que la forme nue, et la couverture '
			+ 'sous-compte un modèle qui préfère l\'espacée — le nombre ne veut plus ce qu\'il veut.',
			{ forms: forms });
	return { forms: forms, counts: counts };
}

async function firstTokenCollision( tokenize, codes, opts ) {
	const seen = new Map();
	const collisions = [];
	for ( const c of codes ) {
		const t = await tokenize(String(c));
		const k = String(t[0]);
		if ( seen.has(k) ) collisions.push([ seen.get(k), c ]); else seen.set(k, c);
	}
	const ok = collisions.length === 0;
	if ( !ok && opts && opts.strict )
		throw fail('FIRST_TOKEN_COLLISION', 'FIRST_TOKEN_COLLISION — tokenizer: ' + collisions.length
			+ ' paire(s) de codes partagent leur premier token : régime « code direct » refusé, utiliser les lettres.',
			{ collisions });
	return { ok, collisions };
}

/**
 * `/tokenize` : llama-server `{content}` → `{tokens}` ; vLLM `{model, prompt}` → `{tokens}`.
 * Les deux serveurs exposent ce chemin à la RACINE (pas sous `/v1`), d'où le `baseUrl` rogné : c'est
 * le CORPS qui porte le dialecte, pas l'URL.
 */
function makeHttpTokenizer( o ) {
	const f = (o && o.fetch) || globalThis.fetch;
	const kind = (o && o.kind) || 'vllm';
	const base = String((o && o.baseUrl) || '').replace(/\/v1\/?$/, '').replace(/\/$/, '');
	return async function tokenize( text ) {
		const body = kind === 'llama-server'
			? { content: String(text), add_special: false, with_pieces: false }
			: { model: o.model, prompt: String(text), add_special_tokens: false };
		const r = await f(base + '/tokenize', {
			method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
		});
		if ( !r.ok ) throw fail('TOKENIZE_HTTP', 'TOKENIZE_HTTP — tokenizer: ' + base + '/tokenize → ' + r.status);
		const j = await r.json();
		return (j && j.tokens) || [];
	};
}

module.exports = { checkLetters, checkBoundary, checkSpacedLetters, firstTokenCollision, makeHttpTokenizer };
