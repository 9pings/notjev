'use strict';
/**
 * set.js — LA COORDONNÉE COMME ENSEMBLE DE NŒUDS ACTIFS.
 *
 * Une coordonnée est un ENSEMBLE, jamais un point : un Choice par division (argmax = le pôle actif)
 * plus, quand la question se pose, un Noul « cette division s'applique-t-elle ? ».
 *
 * Mesuré (292 objets, 27B, packed) : exact-set 0,692 / Jaccard 0,817, contre un nul PRÉ-INSCRIT
 * (le pôle majoritaire par division, écrit avant la mesure) à 0,291 / 0,552. Et le résultat qui
 * commande la conception : serrer à p1 ≥ 0,9 monte la précision par nœud à 0,90 MAIS fait tomber
 * l'exact-set à 0,565 (0,435 en serrant la MARGE) — **la bande est un CURSEUR de fiabilité par
 * nœud, elle ne constitue pas l'ensemble**. D'où `readSet` : le seuil RETIRE des nœuds vers
 * `undecided`, il n'en ajoute jamais, et ce qui est retiré reste lisible.
 */
const readout = require('./readout');
const BANDS = readout.BANDS;

/**
 * @param o `{ divisions:[{ id, poles, probabilities, applies? }], theta?, minBand?, edges? }`
 *          — `applies` = p(oui) du Noul ; sous 0,5 la division est `skipped` (pas `undecided` :
 *          la question ne se pose pas, ce n'est pas une hésitation).
 * @returns `{ active, undecided, skipped }`
 */
function readSet( o ) {
	const theta = (o && o.theta) === undefined ? 0 : o.theta;
	const minRank = (o && o.minBand) ? BANDS.indexOf(o.minBand) : 0;
	const active = [], undecided = [], skipped = [];
	for ( const d of ((o && o.divisions) || []) ) {
		if ( d.applies !== undefined && d.applies !== null && !(d.applies >= 0.5) ) {
			skipped.push({ division: d.id, applies: d.applies });
			continue;
		}
		const v = readout.decide({ probabilities: d.probabilities, options: d.poles, theta, edges: o && o.edges });
		const row = { division: d.id, node: v.top, p: v.p1, margin: v.margin, band: v.band, prior: v.prior };
		if ( v.undecided || BANDS.indexOf(v.band) < minRank ) undecided.push(row); else active.push(row);
	}
	return { active, undecided, skipped };
}

/**
 * LES QUATRE CHIFFRES D'UN ENSEMBLE contre son gold. `exact` est binaire (0/1) : c'est la mesure
 * exigeante, celle qui ne pardonne pas un nœud de trop. Jaccard dit de combien on est passé à côté.
 */
function setMetrics( predicted, gold ) {
	const P = new Set(predicted), G = new Set(gold);
	let inter = 0;
	for ( const x of P ) if ( G.has(x) ) inter++;
	const union = new Set([...P, ...G]).size;
	return {
		exact    : P.size === G.size && inter === P.size ? 1 : 0,
		jaccard  : union ? inter / union : 1,
		precision: P.size ? inter / P.size : (G.size ? 0 : 1),
		recall   : G.size ? inter / G.size : 1,
	};
}

/**
 * LA COURBE DU CURSEUR — les quatre chiffres à chaque seuil de `p`, moyennés PAR OBJET (macro).
 * C'est la sortie publiable : un seuil unique cacherait que la précision monte pendant que
 * l'ensemble se vide.
 */
function curveByBand( objects, cuts ) {
	return (cuts || [0, 0.5, 0.75, 0.9]).map(( minP ) => {
		const acc = { minP, exact: 0, jaccard: 0, precision: 0, recall: 0, n: 0 };
		for ( const o of (objects || []) ) {
			const m = setMetrics(o.predicted.filter(( x ) => x.p >= minP ).map(( x ) => x.node ), o.gold);
			acc.exact += m.exact; acc.jaccard += m.jaccard; acc.precision += m.precision; acc.recall += m.recall;
			acc.n++;
		}
		for ( const k of ['exact', 'jaccard', 'precision', 'recall'] ) acc[k] = acc.n ? acc[k] / acc.n : 0;
		return acc;
	});
}

module.exports = { readSet, setMetrics, curveByBand };
