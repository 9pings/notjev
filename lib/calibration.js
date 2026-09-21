'use strict';
/**
 * calibration.js — LA TEMPÉRATURE, ajustée sur un split CALIB (jamais sur l'éval), publiée avec lui.
 *
 * Mesuré 20-21/09 : ECE brut 0,167 → 0,096 (1,7B), 0,121 → 0,051 (8B), 0,035 → 0,017 (27B) ; le T
 * ajusté va de 15,9 (le petit modèle, écrasé de confiance) à 0,80 (le 27B, légèrement sous-confiant).
 * Un T ajusté sur un jeu et appliqué à un autre est un TRANSFERT : il se publie comme tel, avec le
 * split d'origine — d'où le champ `split`, qui vaut `'undeclared'` tant que l'appelant ne le nomme
 * pas. Un T sans son split n'est pas une calibration, c'est un réglage.
 *
 * Ce qui est calibré, c'est la DISTRIBUTION, donc la marge et la bande — pas le verdict : l'argmax
 * est invariant par température (la monotonie de x ↦ x^(1/T) le garantit). Calibrer ne change donc
 * jamais qui gagne, seulement ce qu'on a le droit d'en dire.
 */
const readout = require('./readout');
const metrics = require('./metrics');

/** `p ↦ softmax(log p / T)` — T > 1 aplatit, T < 1 durcit, T = 1 est l'identité. */
function applyTemperature( probabilities, T ) {
	const t = Number(T) > 0 ? Number(T) : 1;
	const z = (probabilities || []).map(( p ) => Math.log(Math.max(Number(p), 1e-300)) / t );
	const m = Math.max.apply(null, z);
	const e = z.map(( x ) => Math.exp(x - m) );
	const s = e.reduce(( a, b ) => a + b, 0 );
	return e.map(( x ) => x / s );
}

/** La log-vraisemblance négative moyenne de la bonne option — le critère ajusté. */
function nll( rows, T ) {
	let s = 0;
	for ( const r of rows ) s -= Math.log(Math.max(applyTemperature(r.probabilities, T)[r.label], 1e-300));
	return rows.length ? s / rows.length : 0;
}

/**
 * L'ECE à température T.
 *
 * NOTE DE CONTRAT : `metrics.ece` lit `r.p1` (pas `r.p`) et rend `{ ece, bins, n }` (pas un nombre nu).
 * Les deux écarts ont été vérifiés dans `lib/metrics.js` avant d'écrire cette ligne — un `{ p }` ici
 * aurait rendu `ece: null` en silence, et un « ECE qui ne bouge pas » aurait été lu comme un résultat.
 */
function eceOf( rows, T ) {
	const xs = rows.map(( r ) => {
		const p = applyTemperature(r.probabilities, T);
		let i1 = 0;
		for ( let i = 1; i < p.length; i++ ) if ( p[i] > p[i1] ) i1 = i;
		return { p1: p[i1], correct: i1 === r.label };
	});
	const out = metrics.ece(xs, 10);
	return typeof out === 'number' ? out : out.ece;
}

/**
 * LE T QUI MINIMISE LA NLL — grille log-espacée puis raffinement local : robuste, sans dépendance.
 *
 * @param rows `[{ probabilities:number[], label:number }]` — `label` = INDEX de la bonne option.
 * @param o `{ grid?, split? }`
 * @returns `{ T, nll, eceBefore, eceAfter, n, split }`
 */
function fitTemperature( rows, o ) {
	const xs = (rows || []).filter(( r ) => r && Array.isArray(r.probabilities) && r.label >= 0 );
	const grid = (o && o.grid) || (() => {
		const g = [];
		for ( let x = -3; x <= 3.92; x += 0.05 ) g.push(Math.exp(x));
		return g;
	})();
	let best = 1, bestNll = Infinity;
	for ( const T of grid ) { const v = nll(xs, T); if ( v < bestNll ) { bestNll = v; best = T; } }
	for ( let step = best * 0.1; step > best * 1e-3; step /= 2 )
		for ( const T of [best - step, best + step] )
			if ( T > 0 ) { const v = nll(xs, T); if ( v < bestNll ) { bestNll = v; best = T; } }
	return {
		T        : best,
		nll      : bestNll,
		eceBefore: eceOf(xs, 1),
		eceAfter : eceOf(xs, best),
		n        : xs.length,
		split    : (o && o.split) || 'undeclared',
	};
}

/**
 * UNE DÉCISION RECALIBRÉE — probabilités, p1/p2, marge, bande et prior recalculés à T.
 * `degraded` reste vrai s'il l'était : une distribution vide ne se calibre pas, elle s'abstient.
 */
function calibrated( decision, T ) {
	const p = applyTemperature(decision.probabilities, T);
	const v = readout.decide({
		probabilities: p, options: decision.options, theta: decision.theta, edges: decision.edges,
	});
	const undecided = v.undecided || !!decision.degraded;
	return Object.assign({}, decision, v, {
		probabilities: p,
		T            : Number(T),
		choice       : undecided ? null : v.choice,
		index        : undecided ? -1 : v.index,
		undecided    : undecided,
	});
}

module.exports = { applyTemperature, fitTemperature, calibrated, nll };
