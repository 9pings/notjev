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
test('harness: letterPrior estime la masse marginale par LETTRE et publie split/tokenizer', () => {
	/* Quatre bras permutés (référentiel PRÉSENTÉ) : chaque position a reçu le même contenu deux fois
	 * — la moyenne par colonne est le prior sur les lettres, pas sur les contenus. */
	const arms = [
		{ mass: [0.8, 0.2] }, { mass: [0.7, 0.3] },
		{ mass: [0.3, 0.7] }, { mass: [0.2, 0.8] },
	];
	const p = H.letterPrior(arms, { split: 'calib', tokenizer: 'qwen3' });
	assert.ok(Math.abs(p.prior[0] - 0.5) < 1e-12, 'la masse par lettre se lave du contenu');
	assert.ok(Math.abs(p.kl) < 1e-12, 'un prior uniforme a une concentration nulle (KL à l\'uniforme)');
	assert.equal(p.n, 4); assert.equal(p.split, 'calib'); assert.equal(p.tokenizer, 'qwen3');
	const b = H.letterPrior([{ mass: [0.9, 0.1] }]);
	assert.ok(Math.abs(b.prior[0] - 0.9) < 1e-12 && b.split === 'undeclared' && b.tokenizer === 'undeclared',
		'sans déclaration, le prior est publié comme UNDECLARED — c\'est un transfert, pas un réglage');
	assert.ok(b.kl > 0, 'un prior concentré a une concentration positive');
});
test('harness: NEGATIVE CONTROL — à K = 2 les seeds 1..12 de permute donnent TOUS le swap', () => {
	/* Ce test DOCUMENTE le comportement seedé (rejouable) de permute : à K = 2, chaque seed ≥ 1 rend
	 * le même ordre. Ce n'est pas un bug de permute (c'est sa garantie de rejeu) — c'est la raison
	 * pour laquelle l'estimation d'un prior lettre n'a PAS le droit de se contenter de seeds
	 * consécutifs : les ordres doivent être ÉQUILIBRÉS par question (identité + swap à parts
	 * égales), sinon le signal de contenu se lit comme un prior de lettre. */
	const orders = new Set();
	for ( let s = 1; s <= 12; s++ ) orders.add(H.permute({ options: ['a', 'b'] }, s).order.join(''));
	assert.equal(orders.size, 1, 'permute a changé de comportement — les fixtures de campagne ne se rejouent plus');
});
test('harness: letterPrior récupère un prior CONNU sous ordres équilibrés — et documente les deux biais', () => {
	/* Générateur synthétique : masse(lettre j | contenu c) = prior[j] × contenu[c] — la décomposition
	 * de Zheng et al. Ce test vérifie la RECETTE du prior (masse brute + ordres équilibrés) : c'est
	 * lui qui refuse l'estimateur renormalisé ET les seeds consécutifs. */
	const priorLettre = [0.8, 0.2], contenu = [0.9, 0.1];
	const gen = ( ordre ) => ({ mass: ordre.map(( c, j ) => priorLettre[j] * contenu[c] ) });
	/* Équilibré (identité + swap) : le contenu se lave EXACTEMENT, le prior lettre est récupéré. */
	const ok = H.letterPrior([gen([0, 1]), gen([1, 0])]);
	assert.ok(Math.abs(ok.prior[0] - 0.8) < 1e-12,
		'sous ordres équilibrés, letterPrior doit récupérer le prior lettre (0.8), pas le contenu');
	/* Biais 1 — non équilibré (swap seul, comme les seeds consécutifs à K = 2) : le contenu FAUSSE
	 * le prior. */
	const faux = H.letterPrior([gen([1, 0])]);
	assert.ok(Math.abs(faux.prior[0] - 0.3077) < 1e-3,
		'un seul ordre laisse lire le contenu (0.31) comme un prior de lettre — la faille que '
		+ 'l\'équilibre des ordres doit exclure');
	/* Biais 2 — l'estimande renormalisé : moyenner des PROBABILITÉS (au lieu des masses) déforme le
	 * prior MÊME sous ordres équilibrés. */
	const r1 = gen([0, 1]); r1.mass = r1.mass.map(( x ) => x / (r1.mass[0] + r1.mass[1]) );
	const r2 = gen([1, 0]); r2.mass = r2.mass.map(( x ) => x / (r2.mass[0] + r2.mass[1]) );
	const biais = H.letterPrior([r1, r2]);
	assert.ok(Math.abs(biais.prior[0] - 0.6403) < 1e-3,
		'moyenner des probabilités renormalisées lit 0.64 pour un prior de 0.8 — biais documenté : '
		+ 'l\'estimande est la MASSE');
});
test('harness: letterPrior refuse le vide, le menu mité et écarte les bras dégradés', () => {
	assert.throws(() => H.letterPrior([]), ( e ) => e.code === 'PRIOR_EMPTY');
	assert.throws(() => H.letterPrior([{ probabilities: [0.5, 0.5] }]), ( e ) => e.code === 'PRIOR_EMPTY',
		'un bras sans `mass` refuse : les `probabilities` renormalisées sont le MAUVAIS estimande');
	assert.throws(() => H.letterPrior([{ mass: [0.5, 0.5] }, { mass: [1, 0, 0] }]),
		( e ) => e.code === 'PRIOR_RAGGED', 'le prior dépend de la TAILLE du menu, on ne moyenne pas deux menus');
	const p = H.letterPrior([{ mass: [0.9, 0.1] }, { mass: [0.5, 0.5], degraded: true }]);
	assert.equal(p.n, 1, 'un bras DÉGRADÉ dit « autre chose », pas une masse par lettre — il diluerait le prior');
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
