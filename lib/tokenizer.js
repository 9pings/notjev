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

async function checkBoundary( tokenize, prompt, letter ) {
	const base = await tokenize(String(prompt));
	const withL = await tokenize(String(prompt) + String(letter));
	const ok = withL.length === base.length + 1 && base.every(( id, i ) => id === withL[i] );
	if ( !ok ) throw fail('ANSWER_BOUNDARY', 'ANSWER_BOUNDARY — tokenizer: prompt+' + JSON.stringify(letter)
		+ ' ne tokenise pas en prompt ++ [token] : la frontière de réponse change la tokenisation.',
		{ base: base.length, withLetter: withL.length });
	return { id: withL[withL.length - 1] };
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

module.exports = { checkLetters, checkBoundary, firstTokenCollision, makeHttpTokenizer };
