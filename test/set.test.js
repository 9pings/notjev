'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/set');

test('set: readSet prend l\'argmax par division, saute une division qui ne s\'applique pas', () => {
	const r = S.readSet({ divisions: [
		{ id: 'portée', poles: ['faible', 'moyenne', 'grande'], probabilities: [0.02, 0.9, 0.08] },
		{ id: 'motorisation', poles: ['manuel', 'motorisé'], probabilities: [0.55, 0.45] },
		{ id: 'flash', poles: ['sans', 'avec'], probabilities: [0.9, 0.1], applies: 0.2 } ] });
	assert.deepEqual(r.active.map(( a ) => a.node ), ['moyenne', 'manuel']);
	assert.equal(r.active[0].band, 'certain'); assert.equal(r.skipped[0].division, 'flash');
});
test('set: minBand est un curseur — il retire des nœuds, il ne complète pas', () => {
	const r = S.readSet({ minBand: 'high', divisions: [{ id: 'd', poles: ['a', 'b'], probabilities: [0.6, 0.4] }] });
	assert.equal(r.active.length, 0); assert.equal(r.undecided.length, 1);
});
test('set: exact-set, Jaccard, précision/rappel par nœud', () => {
	const m = S.setMetrics(['a', 'b', 'c'], ['a', 'b', 'd']);
	assert.equal(m.exact, 0); assert.ok(Math.abs(m.jaccard - 0.5) < 1e-12); assert.ok(Math.abs(m.precision - 2 / 3) < 1e-12);
	assert.equal(S.setMetrics(['a'], ['a']).exact, 1);
});

/*
 * LA BARRE 0,692 / 0,817 — lecture alignée sur `scripts/score_coord.py` (fonction `ensemble`) :
 * l'ensemble PRÉDIT est `{(division, pôle argmax)}` sur les lignes qui portent une distribution, et
 * il se compare à l'ensemble GOLD du même objet. Le scoreur de référence prend le gold dans le RAW
 * (`row.oracle`) ; le test le prend dans l'échantillon (`treillis_sample.json`, `noeuds[].actif`,
 * `INDECIDABLE` exclu) — les deux sources donnent EXACTEMENT les mêmes chiffres (vérifié : 0,6918 /
 * 0,8169 des deux côtés), ce qui vaut contrôle croisé de la lecture.
 *
 * Réserve déclarée : `curveByBand` moyenne précision et rappel PAR OBJET (macro), là où le scoreur
 * de campagne les met en commun (micro). Exact-set et Jaccard, eux, sont des moyennes par objet des
 * deux côtés — ce sont les deux chiffres que la barre nomme, et ce sont eux qui sont testés ici.
 */
test('set: la campagne coordonnées redonne exact-set 0,692 / Jaccard 0,817 à minP 0', () => {
	const fix = require('./fixtures/treillis_coords.json'), sample = require('./fixtures/treillis_sample.json');
	const objects = fix.results.map(( o ) => {
		const gold = sample.coords[o.id].noeuds.filter(( n ) => n.actif && n.actif !== 'INDECIDABLE' ).map(( n ) => n.division + '=' + n.actif );
		const predicted = o.rows.filter(( r ) => r.probabilities ).map(( r ) => { const i = r.probabilities.indexOf(Math.max(...r.probabilities)); return { node: r.division + '=' + r.poles[i], p: r.probabilities[i] }; });
		return { predicted, gold }; });
	const c = S.curveByBand(objects);
	const at0 = c.find(( x ) => x.minP === 0 ), at9 = c.find(( x ) => x.minP === 0.9 );
	assert.equal(at0.n, 292);
	assert.ok(Math.abs(at0.exact - 0.692) < 0.01, 'exact ' + at0.exact); assert.ok(Math.abs(at0.jaccard - 0.817) < 0.01);
	assert.ok(at9.precision > at0.precision && at9.exact < at0.exact);        // le curseur : précision ↑, exact-set ↓
});

/* Le nul PRÉ-INSCRIT de la campagne (le pôle majoritaire par division, écrit avant la mesure) :
 * 0,291 / 0,552. Sans lui, 0,692 ne dit rien — c'est la règle du bras nul sur le mesurande. */
test('set: le bras nul pré-inscrit reste loin derrière (0,291 / 0,552)', () => {
	const fix = require('./fixtures/treillis_coords.json'), sample = require('./fixtures/treillis_sample.json');
	const poles = sample.nulEnsemble.poles;
	let ex = 0, ja = 0, n = 0;
	for ( const o of fix.results ) {
		const genre = sample.coords[o.id].genre;
		const rows = o.rows.filter(( r ) => r.probabilities );
		const gold = rows.map(( r ) => r.division + '=' + r.oracle );
		const pred = rows.map(( r ) => r.division + '=' + (poles[genre] || {})[r.division] );
		const m = S.setMetrics(pred, gold);
		ex += m.exact; ja += m.jaccard; n++;
	}
	assert.equal(n, 292);
	assert.ok(Math.abs(ex / n - sample.nulEnsemble.exactSet) < 0.01, 'nul exact ' + ex / n);
	assert.ok(Math.abs(ja / n - sample.nulEnsemble.jaccard) < 0.01, 'nul jaccard ' + ja / n);
});
