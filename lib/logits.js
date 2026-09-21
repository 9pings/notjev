'use strict';
/**
 * logits.js — LIRE DES LOGITS ARBITRAIRES (une couche intermédiaire, une sonde), pas seulement une
 * réponse HTTP. `readout.distribution` ne connaît que des entries `{token, logprob}` : ce module en
 * fabrique depuis des logits de lettres + le logsumexp du vocabulaire (logprob = logit − lse).
 * C'est le contrat que la sonde d'élagage (Python) implémente couche par couche.
 *
 * POURQUOI LES TOKENS SONT EXPLICITES (amendement wiseways 21/09) : la sonde enregistre `'A'`, `' A'`,
 * `'B'`, `' B'` séparément. Un helper qui ne prendrait que des LETTRES devrait DEVINER les variantes
 * d'espace ; ici on les reçoit. `exactMass` et `spacedMass` restent donc deux faits distincts, et
 * personne n'invente la forme du token qu'il n'a pas vu.
 *
 * POURQUOI `lse` EST OPTIONNEL : avec le logsumexp du vocabulaire, les logprobs sont ABSOLUS et la
 * `coverage` a un sens (la part de masse que les options portent). Sans lui, on ne peut normaliser
 * que sur les tokens fournis : la distribution reste juste, mais la coverage ne veut plus rien dire.
 * On marque alors `entries.relative = true` et le consommateur rend `coverage: null` — ni `1` (ce
 * serait un mensonge), ni `degraded` (ce n'est pas une absence de masse, c'est une absence de
 * référence).
 */
const { fail } = require('./errors');

function entriesFromLetterLogits( o ) {
	const letters = (o && o.letters) || [];
	const logits = (o && o.logits) || [];
	const spaced = (o && o.spacedLogits) || null;
	const lse = Number(o && o.lse);
	if ( letters.length !== logits.length || (spaced && spaced.length !== letters.length) || !isFinite(lse) )
		// Le code est DANS le message autant que dans `e.code` : une erreur de contrat doit se nommer
		// même quand on ne lit qu'une stack. (Le plan met le code dans `e.code` seul, mais son propre
		// test l'attend dans le message — les deux sont ici, rien n'est perdu.)
		throw fail('LOGITS_SHAPE', 'LOGITS_SHAPE — logits: ' + logits.length + ' logit(s) pour ' + letters.length
			+ ' lettre(s), lse=' + (o && o.lse) + ' : le contrat est une valeur par lettre et un lse fini.');
	const out = [];
	for ( let i = 0; i < letters.length; i++ ) {
		const lp = Number(logits[i]) - lse;
		if ( isFinite(lp) ) out.push({ token: String(letters[i]), logprob: lp });
	}
	if ( spaced ) for ( let i = 0; i < letters.length; i++ ) {
		const lp = Number(spaced[i]) - lse;
		if ( isFinite(lp) ) out.push({ token: ' ' + String(letters[i]), logprob: lp });
	}
	return out;
}

/** TOKENS EXPLICITES (la primitive) : `[{token, logit}]` (+ `lse` optionnel) → entries. Sans `lse`, la
 *  masse est relative aux tokens fournis (logsumexp local) et `entries.relative = true` : le consommateur
 *  rend `coverage: null` — ni 1 (ce serait un mensonge), ni degraded (ce n'est pas une absence). */
function entriesFromLogits( o ) {
	const toks = (o && o.tokens) || [];
	if ( !toks.length ) throw fail('LOGITS_SHAPE', 'LOGITS_SHAPE — logits: aucun token fourni.');
	let lse = o && o.lse, relative = false;
	if ( lse === undefined || lse === null ) {
		const m = Math.max.apply(null, toks.map(( t ) => Number(t.logit) ));
		lse = m + Math.log(toks.reduce(( s, t ) => s + Math.exp(Number(t.logit) - m), 0 ));
		relative = true;
	}
	const out = [];
	for ( const t of toks ) {
		const lp = Number(t.logit) - Number(lse);
		if ( isFinite(lp) ) out.push({ token: String(t.token), logprob: lp });
	}
	if ( relative ) out.relative = true;
	return out;
}

/** Une décision complète depuis des logits : forme `readResponse`, `source:'logits'`, `coverage:null` si relatif. */
function decideFromLogits( o ) {
	const readout = require('./readout');
	const entries = entriesFromLogits(o);
	const letters = o.letters || readout.lettersOf(o.options);
	const dist = readout.distribution(entries, letters);
	const v = readout.decide({ probabilities: dist.probabilities, options: o.options, theta: o.theta, edges: o.edges });
	const undecided = v.undecided || dist.degraded;
	return Object.assign({}, v, {
		ok        : !dist.degraded,
		choice    : undecided ? null : v.choice,
		undecided : undecided,
		source    : 'logits',
		coverage  : entries.relative ? null : dist.coverage,
		exactMass : dist.exactMass,
		spacedMass: dist.spacedMass,
		degraded  : dist.degraded,
		probabilities: dist.probabilities,
		mass      : dist.mass,
		entries   : entries,
		options   : o.options,
		letters   : letters,
		layer     : o.layer === undefined ? undefined : o.layer,
	});
}

/** `{ token: logprob }` (la forme `top_logprobs[0]` de `/v1/completions`) → entries. */
function entriesFromVocabLogprobs( map ) {
	return Object.keys(map || {}).map(( token ) => ({ token: token, logprob: Number(map[token]) }) );
}

module.exports = { entriesFromLogits, decideFromLogits, entriesFromLetterLogits, entriesFromVocabLogprobs };
