'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../lib/harness');

test('harness: lcg est déterministe', () => { const a = H.lcg(7), b = H.lcg(7); assert.equal(a(), b()); assert.equal(a(), b()); });
test('harness: permute le menu et unpermute remet les probabilités en ordre', () => {
	const q = { question: 'q', options: ['x', 'y', 'z'] };
	const p = H.permute(q, 3);
	assert.deepEqual([...p.question.options].sort(), ['x', 'y', 'z']);
	const dec = { probabilities: p.order.map(( i ) => [0.7, 0.2, 0.1][i] ), options: p.question.options, top: p.question.options[p.order.indexOf(0)] };
	const u = H.unpermute(dec, p.order);
	assert.deepEqual(u.probabilities, [0.7, 0.2, 0.1]); assert.deepEqual(u.options, ['x', 'y', 'z']);
});
test('harness: swapAB échange les blocs et refuse quand un marqueur manque', () => {
	const s = 'Intro\nA : un\n  détail a\nB : deux\nFin';
	assert.equal(H.swapAB(s, { a: 'A :', b: 'B :', end: 'Fin' }), 'Intro\nA : deux\nB : un\n  détail a\nFin');
	assert.throws(() => H.swapAB('rien', { a: 'A :', b: 'B :' }), /SWAP_MARKERS/);
});
test('harness: stratify équilibre par strate, seedé', () => {
	const rows = []; for ( let i = 0; i < 50; i++ ) rows.push({ id: i, fam: i < 40 ? 'a' : 'b' });
	const s = H.stratify(rows, ( r ) => r.fam, 20, 1);
	assert.equal(s.length, 20); assert.equal(s.filter(( r ) => r.fam === 'b' ).length, 10);
	assert.deepEqual(s.map(( r ) => r.id ), H.stratify(rows, ( r ) => r.fam, 20, 1).map(( r ) => r.id ));
});
test('harness: les bras nuls', () => {
	const rows = [{ label: 'AUTRE', options: ['MEME', 'AUTRE'], candidates: ['c1', 'c2'], state: 'zz c2' },
		{ label: 'AUTRE', options: ['MEME', 'AUTRE'], candidates: ['c9', 'c1'], state: 'c1 zz' }, { label: 'MEME', options: ['MEME', 'AUTRE'], candidates: ['c7'], state: 'c7' }];
	const n = H.nullArms(rows);
	assert.ok(Math.abs(n.majority - 2 / 3) < 1e-9);
	assert.equal(typeof n.first, 'number'); assert.equal(typeof n.lexical, 'number');
});

/*
 * LA BARRE 17,7 % (104/588), et LA LECTURE QU'ELLE EXIGE — deux alignements, aucun sur la barre :
 *
 * 1. L'IDENTITÉ D'OPTION, pas l'index. Le bras `perm11` a permuté le MENU : comparer les argmax par
 *    index compare des places, pas des réponses (ça donne 60,7 %, un chiffre qui ne mesure rien).
 *    L'ordre du menu vit dans les JOBS de la campagne (`results/gpu27b_jobs_ancrage_*.json`, 12 Mo
 *    de prompts chacun) ; `ancrage_order.json` en est la projection stricte `{ options, stratum,
 *    label }`, sans recalcul.
 * 2. LA STRATE `multi` (n = 588). Les 183 lignes `absent` n'ont AUCUNE bonne réponse dans le menu
 *    (entité nouvelle) : la campagne les score à part, comme abstention correcte. Les y remettre
 *    donne 21,5 % — un mélange de deux mesurandes.
 *
 * Et un détail de fichier, pas de méthode : 12 des 783 lignes portent un `id` déjà vu (la même
 * ligne source échantillonnée deux fois, avec DEUX listes de candidats différentes). Les deux armes
 * sont dans le même ordre, et `ancrage_order.json` projette la DERNIÈRE occurrence : la lecture
 * garde donc la dernière des deux côtés — sinon on apparierait la liste A d'une arme à la liste B
 * de l'autre (et la lecture lèverait, ce qu'elle a fait).
 *
 * Avec cette lecture : 104/588 = 0,1769, et la montée par cardinalité de la campagne se retrouve
 * telle quelle (2 cand. 14,9 % · 3 : 17,6 % · 4 : 22,0 % · 5 : 33,9 % — LOG.md §⑯ : 15/18/22/34 %).
 */
test('harness: flips sur la campagne ancrage (base vs permutation) ≈ 17,7 %', () => {
	const base = require('./fixtures/ancrage_base.json'), perm = require('./fixtures/ancrage_perm11.json');
	const order = require('./fixtures/ancrage_order.json');
	const rows = ( f, arm ) => {
		const byId = new Map();                                              // dernière occurrence gagnante
		for ( const r of f.results ) {
			const meta = order[arm][r.id];
			if ( !meta || meta.stratum !== 'multi' ) continue;
			const p = r.rows[0].probabilities;
			let i1 = 0; for ( let i = 1; i < p.length; i++ ) if ( p[i] > p[i1] ) i1 = i;
			byId.set(r.id, { id: r.id, top: meta.options[i1] });             // l'ENTITÉ choisie, pas la lettre
		}
		return [...byId.values()];
	};
	const f = H.flips(rows(base, 'base'), rows(perm, 'perm11'));
	assert.equal(f.n, 588);
	assert.equal(f.flips, 104);
	assert.ok(Math.abs(f.rate - 0.177) < 0.02, 'flips ' + f.rate);
});
