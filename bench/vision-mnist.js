#!/usr/bin/env node
'use strict';

// Real vision bench, opt-in. Never run by npm test. Downloads nothing: the MNIST test set must be
// present locally (see the error message for the two curl commands). It walks the PUBLISHED path
// only — createDecisionService + the HTTP context backend — against a multimodal engine
// (llama-server with --mmproj), and scores against MNIST ground-truth labels.
//
//   node bench/vision-mnist.js baseUrl=http://127.0.0.1:8827 model=qwen27b \
//     dir=/tmp/notjev-mnist out=bench/results/vision-mnist-2026-09-22.json
const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');
const { createDecisionService, createHttpContextBackend } = require('../index.js');

const args = Object.fromEntries(process.argv.slice(2).map(v => { const i = v.indexOf('='); return [v.slice(0, i), v.slice(i + 1)]; }));

function readIdx(buffer) {
	const magic = buffer.readUInt32BE(0);
	if (magic === 0x00000803) return { rows: buffer.readUInt32BE(8), cols: buffer.readUInt32BE(12),
		data: buffer.subarray(16), count: buffer.readUInt32BE(4) };
	if (magic === 0x00000801) return { data: buffer.subarray(8), count: buffer.readUInt32BE(4) };
	throw new Error('vision-mnist: not an IDX file');
}
function load(dir, name) {
	const file = path.join(dir, name);
	if (!fs.existsSync(file)) throw new Error('vision-mnist: missing ' + file
		+ '\n  curl -sO https://ossci-datasets.s3.amazonaws.com/mnist/t10k-images-idx3-ubyte.gz'
		+ '\n  curl -sO https://ossci-datasets.s3.amazonaws.com/mnist/t10k-labels-idx1-ubyte.gz');
	return readIdx(zlib.gunzipSync(fs.readFileSync(file)));
}
/* Deterministic sample: the same seed must give the same images, or two runs are not comparable. */
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function crc(bytes) { let c = -1; for (const byte of bytes) { c ^= byte; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ -1) >>> 0; }
function chunk(type, data) {
	const tag = Buffer.from(type), n = Buffer.alloc(4), sum = Buffer.alloc(4);
	n.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([tag, data])));
	return Buffer.concat([n, tag, data, sum]);
}
/** 28×28 grayscale digit → 112×112 black-on-white RGB PNG (data URL). Inverted: ink is dark. */
function digitPng(images, index) {
	const S = images.rows * 4;
	const header = Buffer.alloc(13);
	header.writeUInt32BE(S); header.writeUInt32BE(S, 4); header[8] = 8; header[9] = 2;
	const raw = Buffer.alloc(S * (1 + S * 3));
	for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
		const src = images.data[index * images.rows * images.cols + (y >> 2) * images.cols + (x >> 2)];
		const v = 255 - src;
		const o = y * (1 + S * 3) + 1 + x * 3;
		raw[o] = v; raw[o + 1] = v; raw[o + 2] = v;
	}
	return 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

const OPTIONS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

async function main() {
	const baseUrl = args.baseUrl || process.env.NOTJEV_BASE_URL;
	if (!baseUrl || !args.model) throw new Error('vision-mnist: pass baseUrl= and model=');
	const n = Number(args.n || 150), seed = Number(args.seed || 42);
	const images = load(args.dir || '.', 't10k-images-idx3-ubyte.gz');
	const labels = load(args.dir || '.', 't10k-labels-idx1-ubyte.gz');
	if (images.count !== labels.count) throw new Error('vision-mnist: image/label count mismatch');
	const rand = mulberry32(seed);
	const picks = [], used = new Set();
	while (picks.length < n) { const i = Math.floor(rand() * images.count); if (!used.has(i)) { used.add(i); picks.push(i); } }

	const service = createDecisionService({
		backend: createHttpContextBackend({ baseUrl, model: args.model, timeoutMs: Number(args.timeout || 120000) }),
		concurrency: 2, timeoutMs: Number(args.timeout || 120000),
	});
	async function one(index) {
		const label = String(labels.data[index]);
		const r = await service.decide({
			context: { type: 'fresh', messages: [{ role: 'user', content: [
				{ type: 'text', text: 'Here is a handwritten digit image.' },
				{ type: 'image_url', image_url: { url: digitPng(images, index) } },
			] }] },
			questions: [{ id: 'digit', question: 'the digit written in the image', options: OPTIONS, theta: 0.5 }],
		});
		const row = r.results[0];
		return { index, label, status: row.status, choice: row.choice || null, p1: row.p1 ?? null,
			margin: row.margin ?? null, coverage: row.coverage ?? null, correct: row.choice === label };
	}

	const started = Date.now();
	const rows = [];
	for (let k = 0; k < picks.length; k += 2) for (const p of picks.slice(k, k + 2).map(one)) rows.push(await p);
	await service.close();
	rows.sort(( a, b ) => a.index - b.index);

	const decided = rows.filter(( r ) => r.status === 'decided');
	const hits = rows.filter(( r ) => r.choice === r.label);
	const wrongDecided = decided.filter(( r ) => !r.correct);
	const byDigit = {};
	for (const d of OPTIONS) { const sub = rows.filter(( r ) => r.label === d );
		byDigit[d] = { n: sub.length, correct: sub.filter(( r ) => r.correct).length }; }
	const report = {
		at: new Date().toISOString(), set: 'MNIST test set', n: rows.length, seed,
		model: args.model, baseUrl, theta: 0.5, elapsedMs: Date.now() - started,
		accuracyRaw: +(hits.length / rows.length).toFixed(4),
		decided: decided.length, undecided: rows.length - decided.length,
		precisionAmongDecided: decided.length ? +(hits.length / decided.length).toFixed(4) : null,
		coverageMin: +Math.min(...rows.map(( r ) => r.coverage ?? 1)).toFixed(4),
		p1MedianAmongDecided: +(decided.map(( r ) => r.p1).filter(p => p !== null).sort(( a, b ) => a - b)[Math.floor(decided.length / 2)] || 0).toFixed(4),
		byDigit,
		errorsAmongDecided: wrongDecided.map(( r ) => ({ label: r.label, said: r.choice, p1: +r.p1.toFixed(3) })),
		undecided: rows.filter(( r ) => r.status !== 'decided' ).map(( r ) => ({ label: r.label, top: r.choice, p1: +String(r.p1) })),
	};
	if (args.out) fs.writeFileSync(args.out, JSON.stringify(report, null, 2) + '\n');
	console.log(JSON.stringify(report, null, 2));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
