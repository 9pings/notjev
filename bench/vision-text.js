#!/usr/bin/env node
'use strict';

// Text and screenshot bench, opt-in. Never run by npm test. Downloads nothing: the images are
// RENDERED locally by vision-text-gen.py (Pillow), so the ground truth is known by construction —
// real text rendering (a page of text), and a UI panel that looks like a classic screenshot
// (title bar, sidebar, buttons). It walks the published path only.
//
//   python3 bench/vision-text-gen.py seed=42 n=100 out=/tmp/notjev-text
//   node bench/vision-text.js baseUrl=http://127.0.0.1:8827 model=qwen27b \
//     dir=/tmp/notjev-text out=bench/results/vision-text-2026-09-22.json
const fs = require('node:fs');
const path = require('node:path');
const { createDecisionService, createHttpContextBackend } = require('../index.js');

const args = Object.fromEntries(process.argv.slice(2).map(v => { const i = v.indexOf('='); return [v.slice(0, i), v.slice(i + 1)]; }));

async function main() {
	const baseUrl = args.baseUrl || process.env.NOTJEV_BASE_URL;
	if (!baseUrl || !args.model) throw new Error('vision-text: pass baseUrl= and model=');
	if (!args.dir) throw new Error('vision-text: pass dir= holding the manifest.json rendered by bench/vision-text-gen.py');
	const manifestFile = path.join(args.dir, 'manifest.json');
	if (!fs.existsSync(manifestFile))
		throw new Error('vision-text: missing ' + manifestFile + '\n  python3 bench/vision-text-gen.py seed=42 n=100 out=' + args.dir);
	const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
	const items = manifest.items;

	const service = createDecisionService({
		backend: createHttpContextBackend({ baseUrl, model: args.model, timeoutMs: Number(args.timeout || 120000) }),
		concurrency: 2, timeoutMs: Number(args.timeout || 120000),
	});
	async function one(item) {
		const url = 'data:image/png;base64,' + fs.readFileSync(path.join(args.dir, item.file)).toString('base64');
		const r = await service.decide({
			context: { type: 'fresh', messages: [{ role: 'user', content: [
				{ type: 'text', text: 'Here is ' + (item.task === 'document' ? 'a page of text.' : 'a screenshot of an application window.') },
				{ type: 'image_url', image_url: { url } },
			] }] },
			questions: [{ id: item.task, question: item.question, options: item.options, theta: 0.5 }],
		});
		const row = r.results[0];
		return { task: item.task, target: item.target, status: row.status, choice: row.choice || null,
			p1: row.p1 ?? null, coverage: row.coverage ?? null, correct: row.choice === item.target };
	}

	const started = Date.now();
	const rows = [];
	for (let k = 0; k < items.length; k += 2) for (const p of items.slice(k, k + 2).map(one)) rows.push(await p);
	await service.close();

	function digest(sub) {
		const decided = sub.filter(( r ) => r.status === 'decided');
		const hits = sub.filter(( r ) => r.choice === r.target );
		return { n: sub.length, accuracyRaw: +(hits.length / sub.length).toFixed(4),
			decided: decided.length, undecided: sub.length - decided.length,
			precisionAmongDecided: decided.length ? +(hits.length / decided.length).toFixed(4) : null,
			coverageMin: +Math.min(...sub.map(( r ) => r.coverage ?? 1)).toFixed(4),
			p1MedianAmongDecided: +(decided.map(( r ) => r.p1).filter(p => p !== null).sort(( a, b ) => a - b)[Math.floor(decided.length / 2)] || 0).toFixed(4),
			errorsAmongDecided: decided.filter(( r ) => !r.correct ).map(( r ) => ({ target: r.target, said: r.choice, p1: +String(r.p1) })),
			undecided: sub.filter(( r ) => r.status !== 'decided' ).map(( r ) => ({ target: r.target, top: r.choice, p1: +String(r.p1) })),
		};
	}
	const report = {
		at: new Date().toISOString(), set: 'rendered text pages + UI screenshot panels',
		n: rows.length, seed: manifest.seed, model: args.model, baseUrl, theta: 0.5,
		elapsedMs: Date.now() - started,
		document: digest(rows.filter(( r ) => r.task === 'document')),
		screenshot: digest(rows.filter(( r ) => r.task === 'screenshot')),
	};
	if (args.out) fs.writeFileSync(args.out, JSON.stringify(report, null, 2) + '\n');
	console.log(JSON.stringify(report, null, 2));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
