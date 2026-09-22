'use strict';
/**
 * @file bench/throughput.js — THE THROUGHPUT MEASUREMENT, RUNNABLE AGAINST ANY ENGINE.
 *
 * One state per question (the `decideMany` regime: the prefix cache amortises the shared state), at
 * several concurrencies, plus the `packed` regime (N questions per state, one pass). Latency per
 * question is the SERVER's, wall-clock q/s is the CLIENT's: both are printed, never mixed.
 *
 * Run :
 *   node bench/throughput.js --base-url http://127.0.0.1:8000 --model Qwen3.8-27B-NVFP4 \
 *        [--gold /path/to/gold.jsonl] [--n 24] [--concs 1,4] [--packed 12] [--raw bench/results/out.json]
 *
 * The bench is deliberately SMALL (default ~60 requests): it runs against a shared engine, it is
 * not a load test. p50/p95 come from the per-question `ms` of the readout itself.
 */
const fs = require('node:fs');
const path = require('node:path');
const nj = require('..');

const arg = ( n, d ) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const BASE = arg('base-url'), MODEL = arg('model');
const BACKEND = arg('backend', 'chat');   /* 'chat' (createClient) or 'llama' (/completion + n_probs) */
const GOLD = arg('gold', '/mnt/wsl/WipDrive/_perso/wiseways.me/WIP/data/jev-bench/gold.jsonl');
const N = Number(arg('n', 24));
const CONCS = String(arg('concs', '1,4')).split(',').map(Number);
const NPACKED = Number(arg('packed', 12));
const RAW = arg('raw', null);

if ( !BASE || !MODEL ) {
	console.error('usage: node bench/throughput.js --base-url http://… --model <name> [--backend chat|llama] [--gold …] [--n 24] [--concs 1,4] [--packed 12] [--raw out.json]');
	process.exit(1);
}

const pct = ( xs, p ) => {
	const s = [...xs].sort(( a, b ) => a - b );
	return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const r3 = ( x ) => Math.round(x * 10) / 10;

(async () => {
	const gold = fs.readFileSync(GOLD, 'utf8').split('\n').filter(Boolean)
		.map(( l ) => JSON.parse(l) ).filter(( r ) => r.state && (r.options || []).length === 2 );
	const states = gold.slice(0, Math.max(N, NPACKED));
	const questions = ( s ) => [{ id: s.id, question: 'verdict', options: ['MEME', 'AUTRE'] }];
	const client = BACKEND === 'llama'
		? nj.backends['llama-server'].createLlamaServerClient({ baseUrl: BASE, nProbs: 40, theta: 0, model: MODEL })
		: nj.createClient({ baseUrl: BASE, model: MODEL, theta: 0, retries: 1 });
	const out = { date: new Date().toISOString(), baseUrl: BASE, model: MODEL, backend: BACKEND, n: N, phases: [] };

	/* Warm-up: the first request pays the model's cold paths — it is not a measurement. */
	for ( const s of states.slice(0, 2) ) await client.decide({ state: s.state, question: 'verdict', options: ['MEME', 'AUTRE'] });

	for ( const conc of CONCS ) {
		const t0 = Date.now();
		const rows = await client.decideMany(null, states.slice(0, N).flatMap(( s ) => questions(s)),
			{ concurrency: conc, onError: 'collect' });
		const wall = Date.now() - t0;
		const ms = rows.filter(( r ) => r && r.ms !== null ).map(( r ) => r.ms );
		const errs = rows.filter(( r ) => r && r.error ).length;
		const toks = rows.reduce(( a, r ) => a + ((r.usage && r.usage.prompt_tokens) || 0), 0);
		out.phases.push({ phase: 'separate', concurrency: conc, questions: rows.length, wallMs: wall,
			qps: rows.length / (wall / 1000), p50: pct(ms, 0.5), p95: pct(ms, 0.95), meanMs: ms.reduce(( a, b ) => a + b, 0) / ms.length,
			errors: errs, promptTokens: toks });
		console.log('separate c' + conc + ' · ' + rows.length + ' q · wall ' + r3(wall / 1000) + ' s · '
			+ r3(rows.length / (wall / 1000)) + ' q/s · p50 ' + r3(pct(ms, 0.5)) + ' ms · p95 ' + r3(pct(ms, 0.95)) + ' ms · errors ' + errs);
	}

	if ( NPACKED > 0 ) {
		const tokenize = nj.tokenizer.makeHttpTokenizer({ baseUrl: BASE, model: MODEL });
		const pk = nj.packed.createPackedClient({ baseUrl: BASE + '/v1', model: MODEL, tokenize, theta: 0 });
		const qs = ( s ) => [
			{ id: s.id + ':verdict', question: 'verdict', options: ['MEME', 'AUTRE'] },
			{ id: s.id + ':kind', question: 'kind', options: ['PERSONNE', 'ORGANISATION', 'LIEU', 'AUTRE'] },
		];
		let wall = 0, nq = 0, ntok = 0;
		const t0 = Date.now();
		for ( const s of states.slice(0, NPACKED) ) {
			const p = await pk.decidePacked(s.state, qs(s));
			wall = Date.now() - t0;
			nq += p.rows.length; ntok += p.packed.nTokens;
		}
		out.phases.push({ phase: 'packed', questions: nq, states: Math.min(NPACKED, states.length),
			wallMs: wall, qps: nq / (wall / 1000), tokens: ntok });
		console.log('packed · ' + nq + ' q on ' + Math.min(NPACKED, states.length) + ' states · wall '
			+ r3(wall / 1000) + ' s · ' + r3(nq / (wall / 1000)) + ' q/s · ' + ntok + ' prompt tokens (state written once)');
	}

	if ( RAW ) {
		fs.mkdirSync(path.dirname(RAW), { recursive: true });
		fs.writeFileSync(RAW, JSON.stringify(out, null, 1));
		console.log('raw -> ' + RAW);
	}
})().catch(( e ) => { console.error('BENCH FAILED:', e.code || '', e.message); process.exit(1); });
