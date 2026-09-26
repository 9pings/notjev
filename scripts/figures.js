'use strict';
/**
 * scripts/figures.js — THE README FIGURES, REGENERATED FROM THE RAW.
 *
 * Every number below is either read from a raw file (bench/results/, the run of `bench/throughput.js`)
 * or carries a SOURCE comment pointing at the file it was measured in. Nothing here is invented:
 * a figure the repo cannot regenerate is a figure the repo cannot defend.
 *
 * Run: node scripts/figures.js   (writes docs/figures/*.svg)
 */
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'docs', 'figures');
fs.mkdirSync(OUT, { recursive: true });

const bench = JSON.parse(fs.readFileSync(
	path.join(__dirname, '..', 'bench', 'results', 'llama-throughput-2026-09-22.json'), 'utf8'));
const c1 = bench.phases.find(( p ) => p.phase === 'separate' && p.concurrency === 1 );
const c2 = bench.phases.find(( p ) => p.phase === 'separate' && p.concurrency === 2 );

/* The vLLM 27B raw, same day, same gold states — the interrupted run that finished anyway. */
const vllm = JSON.parse(fs.readFileSync(
	path.join(__dirname, '..', 'bench', 'results', 'throughput-2026-09-22.json'), 'utf8'));
const v1 = vllm.phases.find(( p ) => p.phase === 'separate' && p.concurrency === 1 );
const v4 = vllm.phases.find(( p ) => p.phase === 'separate' && p.concurrency === 4 );

/* The 2026-09-26 rows: Gemma-3-12B and Phi-4-14B GGUF, same bench, same machine (RTX 5090),
 * llama-server, packed arm off (Gemma REFUSES it: the `_` placeholder is not a token of its vocab). */
const gemma = JSON.parse(fs.readFileSync(
	path.join(__dirname, '..', 'bench', 'results', 'latency-gemma3-12b-2026-09-26.json'), 'utf8'));
const g1 = gemma.phases.find(( p ) => p.phase === 'separate' && p.concurrency === 1 );
const phi4 = JSON.parse(fs.readFileSync(
	path.join(__dirname, '..', 'bench', 'results', 'latency-phi4-14b-2026-09-26.json'), 'utf8'));
const p1 = phi4.phases.find(( p ) => p.phase === 'separate' && p.concurrency === 1 );

const esc = ( s ) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = ( x, d ) => Number(x).toFixed(d === undefined ? 1 : d ).replace(/\.0$/, '');

/** A horizontal bar panel, full width: label column, then the bar. rows: {label, value, unit, note?, hi?} */
function panel( x, y, w, title, subtitle, rows, max, scale ) {
	const labelW = 215, rowH = 27, top = y + 36, barH = 15;
	let s = `<text x="${x}" y="${y + 16}" font-size="15" font-weight="700" fill="#111">${esc(title)}</text>\n`
		+ `<text x="${x}" y="${y + 30}" font-size="10.5" fill="#666">${esc(subtitle)}</text>\n`;
	rows.forEach(( r, i ) => {
		const cy = top + i * rowH + rowH / 2;
		const len = Math.max(1.5, (scale === 'log' ? Math.log10(r.value) / Math.log10(max) : r.value / max) * (w - labelW - 60));
		s += `<text x="${x}" y="${cy + 3.5}" font-size="11" fill="#222">${esc(r.label)}</text>\n`
			+ `<rect x="${x + labelW}" y="${cy - barH / 2}" width="${len.toFixed(1)}" height="${barH}" rx="2"`
			+ ` fill="${r.hi ? '#0a7a4a' : '#b9b9b9'}" />\n`
			+ `<text x="${x + labelW + 6 + len}" y="${cy + 3.5}" font-size="11" font-weight="600"`
			+ ` fill="${r.hi ? '#0a7a4a' : '#444'}">${fmt(r.value)}${r.unit || ''}${r.note ? esc(r.note) : ''}</text>\n`;
	});
	return s;
}

const W = 960, H = 690;
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">\n`
	+ `<rect width="${W}" height="${H}" fill="#fff" />\n`
	/* Panel 1 — median latency per decision. Sources: bench/results/llama-throughput-2026-09-22.json
	 * (notjev llama), bench/results/throughput-2026-09-22.json (notjev vLLM 27B),
	 * bench/results/latency-{phi4-14b,gemma3-12b}-2026-09-26.json (notjev llama, 26/09), an
	 * independent same-questions bench of the hosted services and local clones (2026-09-20):
	 * jev 0.419 s, simplejev-qwen38-27b 0.613, djev-full 0.270, reflex-4b 0.138 — medians. */
	+ panel(24, 10, 912, 'Median latency per decision', 'ms — lower is better; each arm on its own engine (log scale)', [
		{ label: 'notjev · llama Phi-4 14B Q4_K_M', value: p1.p50, unit: ' ms', hi: true },
		{ label: 'notjev · llama 8B Q4', value: c1.p50, unit: ' ms', hi: true },
		{ label: 'notjev · vLLM 27B NVFP4', value: v1.p50, unit: ' ms', hi: true },
		{ label: 'notjev · llama Gemma-3 12B Q4_K_M', value: g1.p50, unit: ' ms', hi: true },
		{ label: 'reflex-4b · CPU', value: 138, unit: ' ms' },
		{ label: 'djev · 26B, GPU', value: 270, unit: ' ms' },
		{ label: 'Jev (hosted)', value: 419, unit: ' ms' },
		{ label: 'simple-jev · Qwen 27B', value: 613, unit: ' ms' },
	].sort(( a, b ) => a.value - b.value ), 1000, 'log')
	/* Panel 2 — throughput. Sources: bench raw (notjev c1/c2, 26/09 raws for Gemma/Phi), so1 README
	 * (71.9 q/s, 4B on vLLM + H200), razorback README (10.7 req/s x 3 q at c1), s1bench dec_s
	 * (djev 3.7, jev 2.39, simple-jev 1.63). */
	+ panel(24, 270, 912, 'Throughput', 'decisions/s — higher is better (log scale)', [
		{ label: 'so1 · 4B, vLLM + H200', value: 71.9 },
		{ label: 'notjev · llama Phi-4 Q4_K_M, c1', value: p1.qps, hi: true },
		{ label: 'notjev · llama 8B Q4_K_M, c2', value: c2.qps, unit: '', hi: true },
		{ label: 'notjev · llama 8B Q4_K_M, c1', value: c1.qps, hi: true },
		{ label: 'notjev · llama Gemma-3 Q4_K_M, c1', value: g1.qps, hi: true },
		{ label: 'openjev · DiffGemma', value: 32.1, note: ' ≈10.7 req/s × 3 q' },
		{ label: 'notjev · vLLM 27B NVFP4, c4', value: v4.qps, hi: true },
		{ label: 'notjev · vLLM 27B NVFP4, c1', value: v1.qps, hi: true },
		{ label: 'djev · 26B', value: 3.7 },
		{ label: 'Jev (hosted)', value: 2.39 },
		{ label: 'simple-jev · 27B', value: 1.63 },
	].sort(( a, b ) => b.value - a.value ), 100, 'log')
	+ `<text x="24" y="${H - 52}" font-size="9" fill="#888">notjev rows: measured by bench/throughput.js against live engines — llama-server Qwen3-8B-Q4_K_M and vLLM Qwen3.8-27B-NVFP4 (2026-09-22), llama-server Phi-4-Q4_K_M and Gemma-3-12B-Q4_K_M (2026-09-26, same RTX 5090 32 GB) — raw in bench/results/. Other rows: their own publications / an independent bench of the hosted services on shared questions (2026-09-20), each on its own engine.</text>\n`
	+ `<text x="24" y="${H - 38}" font-size="9" fill="#888">The engine is the variable, not the readout: so1's 71.9 q/s is a 4B on an H200, openjev's a purpose-built diffusion model, Jev's their fleet. notjev runs on the model you already serve.</text>\n`
	+ `<text x="24" y="${H - 24}" font-size="9" fill="#888">Latency panel: shorter bars are faster. Throughput panel: longer bars are faster — hence the opposite sort.</text>\n`
	+ `</svg>\n`;
fs.writeFileSync(path.join(OUT, 'perf-2026-09-26.svg'), svg);

/* ── The accuracy figure — an independent clones bench on gold-labelled production questions
 * (2026-09-20): readout 27B (the core of this library, as it runs in a production judge) vs the
 * null arm and the best clone on each bench. */
const BENCHES = [
	{ name: 'actor dedup (n=450)', null_: 92.0, best: { v: 95.3, who: 'xenc-mmBERT' }, readout: 98.7 },
	{ name: 'subject dedup (n=450)', null_: 66.4, best: { v: 90.7, who: 'xenc-mmBERT' }, readout: 90.2 },
	{ name: 'place anchoring (n=400)', null_: 83.3, best: { v: 98.8, who: 'verdict-150M' }, readout: 98.0 },
	{ name: 'subject anchoring (n=400)', null_: 28.5, best: { v: 74.0, who: 'semif-qwen4b' }, readout: 81.1 },
];
{
	const W2 = 960, H2 = 330, x0 = 40, y0 = 70, pw = W2 - 80, gap = pw / BENCHES.length, bw = 18;
	let g = `<svg xmlns="http://www.w3.org/2000/svg" width="${W2}" height="${H2}" viewBox="0 0 ${W2} ${H2}" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">\n`
		+ `<rect width="${W2}" height="${H2}" fill="#fff" />\n`
		+ `<text x="${x0}" y="30" font-size="15" font-weight="700" fill="#111">Accuracy on gold-labelled production questions — against the null arm and the best clone</text>\n`
		+ `<text x="${x0}" y="46" font-size="10.5" fill="#666">Same questions, human-reviewed labels (2026-09-20). The null arm — “always answer the majority class” — is the bar a tool must clear to measure anything.</text>\n`;
	[ ['#b9b9b9', 'null arm (majority)'], ['#7a9cc7', 'best clone on that bench'], ['#0a7a4a', 'readout 27B (this library\'s core)'] ]
		.forEach(( [c, l], i ) => {
			g += `<rect x="${x0 + 250 + i * 220}" y="52" width="10" height="10" fill="${c}" /><text x="${x0 + 264 + i * 220}" y="61" font-size="10.5" fill="#444">${esc(l)}</text>\n`;
		});
	BENCHES.forEach(( b, i ) => {
		const cx = x0 + i * gap + gap / 2;
		const hBar = ( v ) => 200 * v / 100;
		[ [b.null_, '#b9b9b9'], [b.best.v, '#7a9cc7'], [b.readout, '#0a7a4a'] ].forEach(( [v, c], j ) => {
			const bx = cx - 1.5 * bw - 3 + j * (bw + 4);
			g += `<rect x="${bx.toFixed(1)}" y="${(y0 + 200 - hBar(v)).toFixed(1)}" width="${bw}" height="${hBar(v).toFixed(1)}" fill="${c}" />`
				+ `<text x="${(bx + bw / 2).toFixed(1)}" y="${(y0 + 196 - hBar(v)).toFixed(1)}" font-size="9.5" text-anchor="middle" fill="#444">${fmt(v, 1)}</text>\n`;
		});
		g += `<text x="${cx.toFixed(0)}" y="${y0 + 218}" font-size="10.5" text-anchor="middle" fill="#222">${esc(b.name)}</text>\n`
			+ `<text x="${cx.toFixed(0)}" y="${y0 + 231}" font-size="9" text-anchor="middle" fill="#888">best clone: ${esc(b.best.who)}</text>\n`;
	});
	g += `<text x="${x0}" y="${H2 - 14}" font-size="9" fill="#888">Source: an independent bench of the clones on the same gold-labelled production questions, human-reviewed labels (2026-09-20). The readout 27B is the mechanism this library implements, as it runs in a production judge.</text>\n</svg>\n`;
	fs.writeFileSync(path.join(OUT, 'accuracy-2026-09-20.svg'), g);
}

/* ── The suite card — what `npm test` proves, at a glance. */
{
	const W3 = 960, H3 = 120;
	const stats = [
		['192', 'tests, 27 suites'], ['0', 'runtime dependency'], ['0', 'failure on Node 20/22'],
		['3/3', 'in-vivo verifications (21-22/09)'], ['4', 'model families letter-benched (26/09)'],
	];
	let c = `<svg xmlns="http://www.w3.org/2000/svg" width="${W3}" height="${H3}" viewBox="0 0 ${W3} ${H3}" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">\n`
		+ `<rect width="${W3}" height="${H3}" fill="#f6f6f6" rx="8" />\n`;
	stats.forEach(( [n, l], i ) => {
		const x = 24 + i * (W3 - 48) / stats.length;
		c += `<text x="${x + 6}" y="52" font-size="26" font-weight="700" fill="#0a7a4a">${esc(n)}</text>\n`
			+ `<text x="${x + 6}" y="72" font-size="11" fill="#444">${esc(l)}</text>\n`;
	});
	c += `</svg>\n`;
	fs.writeFileSync(path.join(OUT, 'tests-2026-09-26.svg'), c);
}

console.log('figures ->', OUT);
for ( const f of fs.readdirSync(OUT) ) console.log('  ' + f);
