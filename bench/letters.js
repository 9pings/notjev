'use strict';
/**
 * @file bench/letters.js — THE LETTER-BIAS PROTOCOL, RUNNABLE AGAINST ANY ENGINE.
 *
 * One campaign, three measurements, per (model, tokenizer, menu size) — the protocol the
 * 8B/27B pair cannot run (it holds the tokenizer fixed, both being Qwen):
 *
 *   1. INVENTORY  — the two surface forms of every letter, against the deployed server
 *                   (`tokenizer.checkSpacedLetters`): `same` (one ID token per option),
 *                   `single` (two), `multi` (the spaced form is unreadable at max_tokens: 1).
 *   2. PRIOR       — the marginal mass per letter, estimated on PERMUTED arms
 *                   (`harness.letterPrior`, PriDe — Zheng et al., ICLR 2024, arXiv:2309.03882),
 *                   label-free, published with its split and its tokenizer. `kl` is the
 *                   concentration: the priors-over-letters hypothesis predicts flip rates rank
 *                   with it ACROSS families.
 *   3. BEFORE/AFTER — flips under menu permutation, and coverage at fixed theta, read from the
 *                   SAME raw distributions with and without the correction — no new calls. The
 *                   honest expectation is MORE COVERAGE AT THE SAME PRECISION, not more precision
 *                   (Pezeshkpour & Hruschka, arXiv:2308.11483: order sensitivity concentrates in
 *                   the close top-2, where theta already bites).
 *
 * TWO METHODOLOGICAL RULES, both paid for in test/harness.test.js:
 *   - BALANCED ORDERS. `harness.permute` is seeded and replayable, and at K = 2 its seeds 1..12
 *     ALL give the same order — estimating a prior from consecutive seeds reads the CONTENT
 *     marginal as a letter prior. This bench enumerates DISTINCT orders per question (at K = 2:
 *     the identity, carried by the base arm, + the swap), which is what washes the content.
 *   - OUT-OF-SAMPLE CORRECTION. The prior applied to question q is estimated WITHOUT q's arms
 *     (leave-one-question-out) — the in-sample number is printed too, as the mechanism's ceiling,
 *     never as the result.
 *
 * Run (HTTP) :
 *   node bench/letters.js --base-url http://127.0.0.1:8000 --model Qwen3.8-27B-NVFP4 \
 *        [--tokenizer vllm|llama-server] [--gold gold.jsonl] [--n 40] [--theta 0.5] [--raw out.json]
 * Run (native, node-llama-cpp, no server) :
 *   node bench/letters.js --model-path /path/Qwen3-8B-Q4_K_M.gguf --gold gold.jsonl [--raw out.json]
 *
 * `--gold` rows: { id?, state, question, options } — ONE menu size per campaign (a ragged set is
 * refused by `letterPrior`: the prior depends on the size of the menu). Default questions: the
 * anchoring pairs of the production judge, K = 2 (the campaign's 5.6 % row).
 */
const fs = require('node:fs');
const path = require('node:path');
const nj = require('..');

const arg = ( n, d ) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const BASE = arg('base-url'), MODEL = arg('model');
const MODELPATH = arg('model-path', null);
const BACKEND = arg('backend', 'chat');   /* 'chat' (/v1/chat/completions, vLLM) or 'llama' (/completion + n_probs) */
const GOLD = arg('gold', null);
const N = Number(arg('n', 40));
const ORDERS = Number(arg('orders', 4));
const THETA = Number(arg('theta', 0.5));
const TKIND = arg('tokenizer', 'vllm');
const TNAME = arg('tokenizer-name', 'undeclared');
const RAW = arg('raw', null);
const SPLIT = 'letters-bench-' + new Date().toISOString().slice(0, 10);

if ( (!BASE || !MODEL) && !MODELPATH ) {
	console.error('usage: node bench/letters.js --base-url http://… --model <name> [--backend chat|llama]'
		+ '\n       node bench/letters.js --model-path /path/model.gguf'
		+ '\n   [--gold gold.jsonl] [--n 40] [--orders 4] [--theta 0.5] [--tokenizer vllm|llama-server]'
		+ '\n   [--tokenizer-name <id>] [--raw out.json]');
	process.exit(1);
}

/** Built-in questions — the anchoring pairs the production judge decides, K = 2 (the campaign's
 *  5.6 % row). For a sharper prior, pass a --gold with a longer menu: the prior depends on K. */
const BUILTIN = [
	{ id: 'p1', state: 'A: "Marie Curie" / B: "Mary Curie" (as heard in a radio transcript)\n', question: 'verdict', options: ['MEME', 'AUTRE'] },
	{ id: 'p2', state: 'A: "Paris, France" / B: "Paris, Texas"\n', question: 'verdict', options: ['MEME', 'AUTRE'] },
	{ id: 'p3', state: 'A: "ACME Industries Ltd" / B: "ACME Industries Limited"\n', question: 'verdict', options: ['MEME', 'AUTRE'] },
	{ id: 'p4', state: 'A: "Jean Dupont, conseiller municipal" / B: "J. Dupont, conseiller municipal"\n', question: 'verdict', options: ['MEME', 'AUTRE'] },
	{ id: 'p5', state: 'A: "OM" / B: "Olympique de Marseille"\n', question: 'verdict', options: ['MEME', 'AUTRE'] },
	{ id: 'p6', state: 'A: "RER ligne B" / B: "ligne B du métro"\n', question: 'verdict', options: ['MEME', 'AUTRE'] },
	{ id: 'p7', state: 'A: "Nikon FM2 (1982, manual focus)" / B: "Nikon FM2n (manual focus)"\n', question: 'verdict', options: ['MEME', 'AUTRE'] },
	{ id: 'p8', state: 'A: "Organisation des Nations unies" / B: "ONU"\n', question: 'verdict', options: ['MEME', 'AUTRE'] },
	{ id: 'p9', state: 'A: "Support vector machine" / B: "SVM"\n', question: 'verdict', options: ['MEME', 'AUTRE'] },
	{ id: 'p10', state: 'A: "Bureau de vote n°12" / B: "bureau n°12 de vote"\n', question: 'verdict', options: ['MEME', 'AUTRE'] },
	{ id: 'p11', state: 'A: "18 rue des Lilas" / B: "18, rue des Lilas"\n', question: 'verdict', options: ['MEME', 'AUTRE'] },
	{ id: 'p12', state: 'A: "Q3 revenue" / B: "third-quarter revenue"\n', question: 'verdict', options: ['MEME', 'AUTRE'] },
];

/** DISTINCT non-identity orders, found by sweeping seeds (permute stays the source of truth):
 *  at K = 2 this is exactly the swap; the identity is carried by the base arm. */
function distinctOrders( options, want ) {
	const seen = new Set([options.map(( _, i ) => i ).join(',')]);
	const out = [];
	for ( let s = 1; s < 1000 && out.length < want; s++ ) {
		const p = nj.harness.permute({ options }, s);
		const key = p.order.join(',');
		if ( seen.has(key) ) continue;
		seen.add(key);
		out.push({ order: p.order, options: p.question.options, seed: s });
	}
	return out;
}

(async () => {
	const questions = (GOLD
		? fs.readFileSync(GOLD, 'utf8').split('\n').filter(Boolean).map(( l ) => JSON.parse(l) )
		: BUILTIN).slice(0, N);
	const client = MODELPATH
		? await nj.backends['node-llama-cpp'].createNodeLlamaClient({ modelPath: MODELPATH, gpu: true, theta: 0 })
		: (BACKEND === 'llama'
			? nj.backends['llama-server'].createLlamaServerClient({ baseUrl: BASE, nProbs: 40, theta: 0, model: MODEL })
			: nj.createClient({ baseUrl: BASE, model: MODEL, theta: 0, retries: 1 }));
	const tokenize = MODELPATH ? client.tokenize
		: (BACKEND === 'llama' ? client.tokenize
			: nj.tokenizer.makeHttpTokenizer({ baseUrl: BASE, kind: TKIND, model: MODEL }));
	const what = MODELPATH ? MODELPATH : (BASE + ' · ' + MODEL);
	/* The honesty rule of lib/backends/node-llama-cpp.js: on this machine the prebuilt picks Vulkan
	 * and loads 0 layers — a CPU run disguised as a GPU one. The protocol is valid on CPU (same
	 * weights, deterministic), but it is LABELLED, never passed off as GPU. */
	const hw = MODELPATH ? ((client.info && client.info.gpuLayers > 0) ? 'gpu' : 'cpu') : 'http';
	if ( MODELPATH && hw === 'cpu' )
		console.log('ATTENTION — native CPU condition (gpuLayers 0, the Vulkan trap of the module header): NOT the'
			+ '\n  campaign\'s instrument. Measured 2026-09-26 on identical prompts and weights: the same gold'
			+ '\n  rows FLIP verdicts between the native CPU build and the GPU llama-server raws'
			+ '\n  (docs/verifications/raw/, see docs/measurements.md). Quote the numbers as CPU-condition.');
	console.log('engine · ' + what + ' · ' + hw);

	/* (1) INVENTORY — against the deployed server (or the loaded model): the detokenised piece
	 *     that comes back is what picks the bucket in `distribution`, not the HF decode. */
	const letters = nj.readout.lettersOf(questions[0].options);
	const inv = await nj.tokenizer.checkSpacedLetters(tokenize, letters);
	console.log('inventory · ' + Object.entries(inv.counts).map(( [ k, v ] ) => k + ' ' + v ).join(' · '));
	for ( const f of inv.forms )
		console.log('  ' + JSON.stringify(f.letter) + ' → bare ' + JSON.stringify(f.bare)
			+ ' · spaced ' + JSON.stringify(f.spaced) + ' · ' + f.regime);

	/* (2) THE ARMS — one identity arm per question (the base), plus DISTINCT non-identity orders.
	 *     Every raw response is KEPT: the before/after reading is offline, from the same
	 *     distributions. Estimation uses ALL arms of a question (identity included): THAT is the
	 *     balance that washes the content — consecutive seeds alone would not. */
	const arms = [];
	for ( const q of questions ) {
		const b = await client.decide(q);
		arms.push({ id: q.id, order: null, options: q.options, resp: b.raw, q: q });
		for ( const o of distinctOrders(q.options, ORDERS) ) {
			const d = await client.decide(Object.assign({}, q, { options: o.options }));
			arms.push({ id: q.id, order: o.order, options: o.options, resp: d.raw, q: q });
		}
		process.stdout.write('\rarms ' + arms.length);
	}
	console.log('\narms ' + arms.length + ' (' + questions.length + ' questions × ' + (arms.length / questions.length) + ' orders)');

	const massOf = ( arm ) => {
		const d = nj.readResponse(arm.resp, { options: arm.options, question: arm.q.question, state: arm.q.state });
		return { mass: d.mass, degraded: d.degraded };
	};

	/* (3) THE PRIORS — on the RAW letter mass, from BALANCED arms. Two: the in-sample one (the
	 *     mechanism's ceiling) and the LEAVE-ONE-QUESTION-OUT one (the honest correction, the
	 *     number this bench exists for). */
	const inSample = nj.harness.letterPrior(arms.map(massOf), { split: SPLIT, tokenizer: TNAME });
	console.log('letterPrior (in-sample) · ' + inSample.prior.map(( p ) => p.toFixed(4)).join(' ')
		+ ' · kl ' + inSample.kl.toFixed(4) + ' · n ' + inSample.n);
	const byQ = questions.map(( q ) => arms.filter(( a ) => a.id === q.id ) );
	const loo = byQ.map(( own ) => {
		const others = arms.filter(( a ) => !own.includes(a) );
		return nj.harness.letterPrior(others.map(massOf), { split: SPLIT + '-loo', tokenizer: TNAME });
	});

	/* (4) BEFORE/AFTER — both readings from the SAME raw. Flips are on the ARGMAX (`top`), never
	 *     on `choice` (an abstention is a reading of the margin, not a flip); `top` is the CODE of
	 *     the chosen letter, so identity and permuted arms compare IDENTITIES, not places. */
	const read = ( arm, lp ) => {
		const d = nj.readResponse(arm.resp, { options: arm.options, question: arm.q.question,
			state: arm.q.state, theta: THETA, letterPrior: lp || null });
		return arm.order ? nj.harness.unpermute(d, arm.order) : d;
	};
	const pairs = [];
	for ( let qi = 0; qi < questions.length; qi++ ) {
		const own = byQ[qi], priorQ = loo[qi];
		const base = own.find(( a ) => !a.order );
		if ( !base ) continue;
		const bBefore = read(base, null), bAfter = read(base, priorQ.prior);
		for ( const a of own.filter(( x ) => x.order ) ) {
			const aBefore = read(a, null), aAfter = read(a, priorQ.prior);
			pairs.push({
				id: questions[qi].id, order: a.order.join(','),
				before: { base: bBefore.top, perm: aBefore.top, marginBase: bBefore.margin, marginPerm: aBefore.margin },
				after : { base: bAfter.top, perm: aAfter.top, marginBase: bAfter.margin, marginPerm: aAfter.margin },
				prior : priorQ.prior,
			});
		}
	}
	const fBefore = pairs.filter(( p ) => p.before.base !== p.before.perm ).length;
	const fAfter = pairs.filter(( p ) => p.after.base !== p.after.perm ).length;
	const decided = ( lp ) => arms.filter(( a ) => {
		const d = read(a, lp ? lp(a) : null);
		return !d.undecided && !d.degraded;
	} ).length;
	const decidedBefore = decided(null);
	const decidedAfter = decided(( a ) => loo[questions.findIndex(( q ) => q.id === a.id )].prior);
	console.log('flips under permutation · before ' + fBefore + '/' + pairs.length
		+ ' (' + (100 * fBefore / (pairs.length || 1)).toFixed(1) + ' %)'
		+ ' · after LOO correction ' + fAfter + '/' + pairs.length
		+ ' (' + (100 * fAfter / (pairs.length || 1)).toFixed(1) + ' %)');
	console.log('decided at theta ' + THETA + ' · before ' + decidedBefore + '/' + arms.length
		+ ' · after LOO ' + decidedAfter + '/' + arms.length);

	const out = {
		date: new Date().toISOString(), engine: what, hardware: hw, backend: MODELPATH ? 'native' : BACKEND,
		tokenizerKind: MODELPATH ? 'native' : (BACKEND === 'llama' ? 'llama-server' : TKIND),
		n: questions.length, orders: ORDERS, theta: THETA, split: SPLIT, tokenizerName: TNAME,
		inventory: inv, letterPriorInSample: inSample, letterPriorLoo: loo.map(( p ) => p.prior ),
		pairs: pairs,
		flips: { before: fBefore, afterLoo: fAfter, pairs: pairs.length },
		decided: { before: decidedBefore, afterLoo: decidedAfter, arms: arms.length },
	};
	if ( RAW ) { fs.mkdirSync(path.dirname(RAW), { recursive: true }); fs.writeFileSync(RAW, JSON.stringify(out)); console.log('raw → ' + RAW); }
	await (client.close ? client.close() : null);
})().catch(( e ) => { console.error('ERR', e.code || '', e.message); process.exit(1); });
