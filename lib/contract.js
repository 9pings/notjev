'use strict';
/**
 * contract.js — LE CONTRAT JSONL, la seule forme que le scoreur lit.
 *
 * Trois implémentations tournent déjà sur ce mesurande (notJev, la sonde d'élagage Python, les
 * clones de la campagne) : ce qui les rend comparables n'est pas leur code, c'est cette forme. Les
 * deux validateurs refusent AVANT la mesure — un champ manquant découvert au moment de scorer
 * signifie qu'on a déjà dépensé le GPU.
 *
 * ENTRÉE — deux portes, et une seule à la fois :
 *   `{ state, question, options }` : la lib rend la chaîne (et la rend toujours de la même façon) ;
 *   `content` : la chaîne DÉJÀ rendue, prise octet pour octet — c'est la porte de la sonde
 *   d'élagage, qui doit envoyer exactement le prompt de son enregistrement.
 *
 * SORTIE — `coverage` est OBLIGATOIREMENT PRÉSENT, et peut valoir `null` : absent, il se lirait
 * comme « tout allait bien » ; `null` dit « cette voie ne permet pas de la calculer » (des logits
 * élagués sans `lse` : les logprobs sont relatifs aux tokens fournis). Ne jamais écrire 1 à sa
 * place — ce serait affirmer que rien n'a été dit hors du menu.
 */
const crypto = require('node:crypto');
const { fail } = require('./errors');

const KINDS = ['choice', 'noul', 'score'];
const SOURCES = ['http', 'logits'];

/** Le sha256 d'un PROMPT — la clé qui apparie une sortie à la chaîne exacte qui l'a produite. */
function sha256( prompt ) {
	return crypto.createHash('sha256').update(String(prompt), 'utf8').digest('hex');
}

function bad( which, msg, row ) {
	return fail(which, which + ' — contract: ' + msg, { row: row && row.id });
}

/** Les champs que toute ligne de SORTIE porte, `null` compris. */
const OUT_REQUIRED = ['id', 'choice', 'p1', 'p2', 'margin', 'band', 'prior', 'coverage',
	'exactMass', 'spacedMass', 'degraded', 'undecided', 'theta', 'probabilities'];

/**
 * @param row la ligne d'entrée.
 * @returns `{ ok: true, rendered }` — `rendered: true` quand la ligne porte `content`.
 */
function validateInput( row ) {
	const r = row || {};
	if ( r.id === undefined || r.id === null ) throw bad('CONTRACT_INPUT', 'une ligne sans `id` ne peut pas être appariée à sa sortie.', r);
	if ( KINDS.indexOf(r.kind) < 0 )
		throw bad('CONTRACT_INPUT', '`kind` vaut ' + JSON.stringify(r.kind) + ' — les trois formes closes sont '
			+ KINDS.join(', ') + '. Une quatrième forme n\'est pas un readout.', r);
	if ( !Array.isArray(r.options) || r.options.length < 2 )
		throw bad('CONTRACT_INPUT', '`options` doit porter au moins 2 entrées (une question à une réponse '
			+ 'n\'est pas une question).', r);
	for ( const o of r.options ) {
		const isCode = typeof o === 'string' || typeof o === 'number';
		if ( !isCode && !(o && typeof o === 'object' && o.id !== undefined) )
			throw bad('CONTRACT_INPUT', 'une option doit être un CODE ou `{ id, description? }`.', r);
	}
	const rendered = r.content !== undefined && r.content !== null;
	if ( !rendered && (r.question === undefined || r.question === null) )
		throw bad('CONTRACT_INPUT', 'ni `content` (la chaîne déjà rendue) ni `question` : il n\'y a rien à demander.', r);
	if ( rendered && typeof r.content !== 'string' )
		throw bad('CONTRACT_INPUT', '`content` doit être la chaîne rendue, octet pour octet.', r);
	if ( r.meta !== undefined && r.meta !== null && typeof r.meta !== 'object' )
		throw bad('CONTRACT_INPUT', '`meta` est libre mais reste un objet.', r);
	return { ok: true, rendered };
}

/**
 * @param row la ligne de sortie.
 * @returns `{ ok: true }` — ou une erreur `CONTRACT_OUTPUT` qui NOMME le champ fautif.
 */
function validateOutput( row ) {
	const r = row || {};
	for ( const k of OUT_REQUIRED )
		if ( !(k in r) )
			throw bad('CONTRACT_OUTPUT', 'champ `' + k + '` ABSENT. Un champ absent se lit comme « tout allait '
				+ 'bien » ; s\'il est inconnu de cette voie, il vaut `null` et le dit.', r);
	if ( !Array.isArray(r.probabilities) )
		throw bad('CONTRACT_OUTPUT', '`probabilities` doit être le tableau des masses renormalisées.', r);
	if ( r.coverage !== null && !(Number(r.coverage) >= 0) )
		throw bad('CONTRACT_OUTPUT', '`coverage` vaut ' + JSON.stringify(r.coverage) + ' — un nombre, ou `null` '
			+ 'quand la voie ne permet pas de la calculer.', r);
	if ( typeof r.undecided !== 'boolean' || typeof r.degraded !== 'boolean' )
		throw bad('CONTRACT_OUTPUT', '`undecided` et `degraded` sont des booléens : une absence de verdict n\'est '
			+ 'pas une valeur manquante.', r);
	if ( r.undecided && r.choice !== null )
		throw bad('CONTRACT_OUTPUT', 'une ligne `undecided` porte `choice: null` — sans quoi un lecteur pressé '
			+ 'appliquerait le verdict que la marge a justement refusé.', r);
	if ( r.source !== undefined && SOURCES.indexOf(r.source) < 0 )
		throw bad('CONTRACT_OUTPUT', '`source` vaut ' + JSON.stringify(r.source) + ' — ' + SOURCES.join(' ou ') + '.', r);
	if ( r.layer !== undefined && r.layer !== null && !(Number.isInteger(r.layer) && r.layer >= 0) )
		throw bad('CONTRACT_OUTPUT', '`layer` est un entier >= 0 (le numéro de couche de la sonde).', r);
	return { ok: true };
}

module.exports = { validateInput, validateOutput, sha256, KINDS, SOURCES, OUT_REQUIRED };
