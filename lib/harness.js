'use strict';
/**
 * harness.js — LA MESURE APPARIÉE.
 *
 * Aucun chiffre sans bras nul SUR LE MESURANDE, et toute perturbation est SEEDÉE donc rejouable.
 * Mesuré 20/09 : flips à la permutation du menu 5,6 % (2 options) → 17,7 % (ancrage, 588 lignes)
 * → 36,7 % (19 options) ; échange A/B dans l'état 26,1 % (8B) et 6,5 % (27B). Ces nombres sont la
 * raison d'être du module : un readout qui change d'avis quand on remue le menu ne lit pas un sens,
 * il lit une place — et seule une mesure appariée le dit.
 *
 * DEUX RÈGLES DE LECTURE, payées sur l'ancrage et inscrites dans les tests :
 *   - on apparie sur l'IDENTITÉ de l'option (le code), jamais sur son index : sous permutation,
 *     comparer des index compare des places ;
 *   - on ne mélange pas deux mesurandes dans un taux (ici : les lignes SANS bonne réponse, où
 *     s'abstenir est la seule conduite juste, se comptent à part).
 */
const { fail } = require('./errors');

/** Un générateur congruentiel : petit, sans dépendance, et surtout REJOUABLE à l'identique. */
function lcg( seed ) {
	let s = (Number(seed) >>> 0) || 1;
	return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/** Fisher-Yates seedé : la permutation d'indices `[0..n-1]`. */
function shuffled( n, rnd ) {
	const a = Array.from({ length: n }, ( _, i ) => i );
	for ( let i = n - 1; i > 0; i-- ) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
	return a;
}

/** Le menu permuté. `order[i]` = l'index D'ORIGINE de l'option présentée en position `i`. */
function permute( question, seed ) {
	const opts = (question && question.options) || [];
	const order = shuffled(opts.length, lcg(seed));
	return { question: Object.assign({}, question, { options: order.map(( i ) => opts[i] ) }), order };
}

/** Le retour au référentiel d'origine — sans quoi deux armes permutées ne sont pas comparables. */
function unpermute( decision, order ) {
	const probs = new Array(order.length), options = new Array(order.length);
	order.forEach(( orig, i ) => { probs[orig] = decision.probabilities[i]; options[orig] = decision.options[i]; });
	return Object.assign({}, decision, { probabilities: probs, options });
}

/**
 * L'ÉCHANGE A/B DANS L'ÉTAT — la perturbation qui teste si le verdict porte sur le CONTENU des deux
 * blocs ou sur leur place. Les marqueurs sont fournis par l'appelant : la lib ne devine aucune mise
 * en page, et une absence de marqueur REFUSE (un échange silencieusement non fait donnerait 0 % de
 * flips, c'est-à-dire le plus beau des faux succès).
 *
 * @param m `{ a, b, end? }` — `end` borne le second bloc ; sans lui, il court jusqu'au bout.
 */
function swapAB( state, m ) {
	const s = String(state);
	const a = s.indexOf(m.a), b = s.indexOf(m.b);
	if ( a < 0 || b < 0 || b < a )
		throw fail('SWAP_MARKERS', 'SWAP_MARKERS — harness.swapAB: marqueurs absents ou inversés ('
			+ JSON.stringify(m.a) + ' / ' + JSON.stringify(m.b) + ') : l\'échange n\'aurait pas lieu, et le '
			+ 'taux de flips mesurerait la comparaison d\'un état avec lui-même.');
	const end = m.end ? s.indexOf(m.end, b) : -1;
	const tail = end >= 0 ? s.slice(end) : '';
	const blockA = s.slice(a, b), blockB = s.slice(b, end >= 0 ? end : s.length);
	const bodyA = blockA.slice(m.a.length), bodyB = blockB.slice(m.b.length);
	return s.slice(0, a) + m.a + bodyB + m.b + bodyA + tail;
}

/**
 * LE TIRAGE STRATIFIÉ, seedé : même quota par strate, puis complément au hasard seedé.
 * `by(row)` rend la clé de strate. Deux appels de même seed rendent exactement les mêmes lignes.
 */
function stratify( rows, by, n, seed ) {
	const rnd = lcg(seed);
	const groups = new Map();
	for ( const r of rows ) { const k = by(r); if ( !groups.has(k) ) groups.set(k, []); groups.get(k).push(r); }
	const keys = [...groups.keys()];
	const per = Math.floor(n / (keys.length || 1));
	const out = [];
	for ( const k of keys ) {
		const g = groups.get(k);
		const idx = shuffled(g.length, rnd).slice(0, per);
		for ( const i of idx ) out.push(g[i]);
	}
	const taken = new Set(out);
	const pool = rows.filter(( r ) => !taken.has(r) );
	const idx = shuffled(pool.length, rnd);
	let rest = n - out.length;
	for ( let i = 0; i < idx.length && rest > 0; i++, rest-- ) out.push(pool[idx[i]]);
	return out;
}

/**
 * LES BRAS NULS — la stratégie la moins chère qui franchit la barre. Tant qu'un readout ne les bat
 * pas, il n'a rien mesuré. Trois, parce que trois faux succès différents ont été évités avec eux :
 * la classe MAJORITAIRE, le PREMIER candidat (l'ordre du blocking n'est pas neutre), et le
 * RECOUVREMENT lexical avec l'état.
 *
 * @param rows `[{ label, options?, candidates?, state? }]` — `label` = la bonne réponse.
 */
function nullArms( rows ) {
	const xs = rows || [];
	const count = new Map();
	for ( const r of xs ) count.set(r.label, (count.get(r.label) || 0) + 1);
	const maj = [...count.entries()].sort(( x, y ) => y[1] - x[1] )[0];
	const acc = ( pred ) => xs.filter(( r ) => pred(r) === r.label ).length / (xs.length || 1);
	return {
		majority: acc(() => maj && maj[0] ),
		first   : acc(( r ) => r.candidates ? r.candidates[0] : (r.options ? r.options[0] : null) ),
		lexical : acc(( r ) => {
			const cands = r.candidates || r.options || [];
			let best = null, bs = -1;
			for ( const c of cands ) {
				const sc = String(r.state || '').includes(String(c)) ? String(c).length : 0;
				if ( sc > bs ) { bs = sc; best = c; }
			}
			return best;
		}),
	};
}

/**
 * LE PRIOR SUR LES LETTRES — la masse marginale par POSITION, estimée sur des bras permutés.
 *
 * C'est le mécanisme de Zheng et al. (ICLR 2024, arXiv:2309.03882, PriDe) : en permutant les
 * CONTENUS sur un petit échantillon et en moyennant la masse par position, le signal de contenu se
 * lave et ce qui reste est le prior du modèle sur les TOKENS D'ID d'option — la cause mesurée des
 * 5,6 % → 36,7 % de flips. Label-free. `distribution(entries, letters, prior)` le divise.
 *
 * TROIS RÈGLES :
 *   - les bras sont dans le référentiel PRÉSENTÉ (AVANT `unpermute`) : le prior est par LETTRE,
 *     et `unpermute` rendrait une moyenne par CONTENU, qui n'est pas cet objet ;
 *   - un bras DÉGRADÉ est écarté : il dit « le modèle a répondu autre chose », pas une masse par
 *     lettre — l'inclure diluerait le prior d'un bruit uniforme ;
 *   - le prior se publie avec son `split` et son `tokenizer`, tous deux `'undeclared'` tant que
 *     l'appelant ne les nomme pas : un prior transporté entre modèles, tokenizers ou tailles de
 *     menu n'est pas le même objet (règle déjà payée par `T` dans calibration.js).
 *
 * ET DEUX EXIGENCES, mesurées sur `permute` et sur un modèle synthétique :
 *   - l'équilibre des ordres appartient À L'APPELANT. À K = 2, les seeds 1..12 de `permute`
 *     rendent TOUS le même ordre (le swap) ; à K = 3, deux sur six. Avec des ordres non
 *     équilibrés par question, le signal de CONTENU ne se lave pas : sur des paires où une option
 *     gagne presque toujours au contenu, la moyenne par lettre lit ce contenu comme un prior.
 *     Le protocole qui équilibre : tous les ordres (K!) par question, ou l'identité + le swap à
 *     parts égales à K = 2 — `bench/letters.js` fait exactement cela ;
 *   - la moyenne porte sur la MASSE BRUTE (`mass` de la décision), pas sur les `probabilities`
 *     renormalisées. Sous la décomposition masse = prior(lettre) × facteur(contenu), les facteurs
 *     par question (couverture comprise) s'annulent ENTRE LETTRES sous ordres équilibrés, et la
 *     masse brute récupère le prior exactement ; la moyenne des renormalisées, elle, est biaisée
 *     par la normalisation propre à chaque bras (prior 0,8/0,2 lu à 0,64/0,36 — test nommé).
 *     C'est aussi l'échelle de `readout.distribution`, qui divise la masse.
 *
 * @param arms `[{ mass:number[], degraded? }]` — le référentiel présenté, ordre des lettres.
 * @param o `{ split?, tokenizer? }`
 * @returns `{ prior:number[], n, kl, split, tokenizer }` — `kl` = KL(prior || uniform) en nats :
 *          la concentration qui prédit le taux de flips, comparable entre familles.
 */
function letterPrior( arms, o ) {
	const xs = (arms || []).filter(( r ) => r && Array.isArray(r.mass) && r.mass.length && !r.degraded );
	if ( !xs.length )
		throw fail('PRIOR_EMPTY', 'PRIOR_EMPTY — harness.letterPrior: aucun bras portant une `mass` (les '
			+ 'décisions de `readout.distribution` la portent ; un bras dégradé n\'est pas une masse par '
			+ 'lettre). Un prior estimé sur rien n\'est pas une correction, c\'est un réglage déguisé.');
	const k = xs[0].mass.length;
	for ( const r of xs )
		if ( r.mass.length !== k )
			throw fail('PRIOR_RAGGED', 'PRIOR_RAGGED — harness.letterPrior: des bras de ' + k + ' et '
				+ r.mass.length + ' options : le prior sur les lettres dépend de la TAILLE du menu, '
				+ 'on ne moyenne pas deux menus.');
	const prior = new Array(k).fill(0);
	for ( const r of xs ) for ( let i = 0; i < k; i++ ) prior[i] += Number(r.mass[i]) || 0;
	const s = prior.reduce(( a, b ) => a + b, 0 ) || 1;
	for ( let i = 0; i < k; i++ ) prior[i] /= s;
	let kl = 0;
	for ( let i = 0; i < k; i++ ) kl += prior[i] * Math.log(prior[i] * k);
	return {
		prior    : prior,
		n        : xs.length,
		kl       : kl,
		split    : (o && o.split) || 'undeclared',
		tokenizer: (o && o.tokenizer) || 'undeclared',
	};
}

/**
 * LE TAUX DE BASCULE entre deux armes appariées par `id`. `top` est l'option retenue — son CODE :
 * sous permutation, un index ne désigne plus la même réponse.
 */
function flips( a, b ) {
	const byId = new Map((b || []).map(( r ) => [String(r.id), r] ));
	let n = 0, f = 0;
	for ( const r of (a || []) ) {
		const o = byId.get(String(r.id));
		if ( !o ) continue;
		n++;
		if ( String(r.top) !== String(o.top) ) f++;
	}
	return { n, flips: f, rate: n ? f / n : 0 };
}

module.exports = { lcg, shuffled, permute, unpermute, swapAB, stratify, nullArms, letterPrior, flips };
