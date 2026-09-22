#!/usr/bin/env node
'use strict';

// Real photo bench, opt-in. Never run by npm test. Downloads nothing: CIFAR-10 must be present
// locally (the python pickle from https://www.cs.toronto.edu/~kriz/cifar-10-python.tar.gz).
// 10 000 REAL COLOUR photographs (32x32, six animal classes, four vehicle classes), labelled —
// it walks the published path only (createDecisionService + the HTTP context backend) against a
// multimodal engine, and scores against the ground truth.
//
//   node bench/vision-animals.js baseUrl=http://127.0.0.1:8827 model=qwen27b \
//     dir=/path/to/cifar-10-batches-py out=bench/results/vision-animals-2026-09-22.json
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { createDecisionService, createHttpContextBackend } = require('../index.js');

const args = Object.fromEntries(process.argv.slice(2).map(v => { const i = v.indexOf('='); return [v.slice(0, i), v.slice(i + 1)]; }));
const CLASSES = ['airplane', 'automobile', 'bird', 'cat', 'deer', 'dog', 'frog', 'horse', 'ship', 'truck'];
/* Deterministic sample: the same seed must give the same images, or two runs are not comparable. */
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function crc(bytes) { let c = -1; for (const byte of bytes) { c ^= byte; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ -1) >>> 0; }
function chunk(type, data) {
	const tag = Buffer.from(type), n = Buffer.alloc(4), sum = Buffer.alloc(4);
	n.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([tag, data])));
	return Buffer.concat([n, tag, data, sum]);
}
/** 32×32 RGB → 128×128 RGB PNG (data URL), nearest-neighbour. */
function photoPng(data, index) {
	const S = 32, D = S * 4;
	const header = Buffer.alloc(13);
	header.writeUInt32BE(D); header.writeUInt32BE(D, 4); header[8] = 8; header[9] = 2;
	const off = index * S * S * 3;
	const raw = Buffer.alloc(D * (1 + D * 3));
	for (let y = 0; y < D; y++) for (let x = 0; x < D; x++) {
		const o = y * (1 + D * 3) + 1 + x * 3;
		const s = off + ((y >> 2) * S + (x >> 2)) * 3;
		raw[o] = data[s]; raw[o + 1] = data[s + 1]; raw[o + 2] = data[s + 2];
	}
	return 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

/* CIFAR's python pickle is unreadable from Node; convert once to raw RGB + labels (stdlib only). */
function prepare(dir) {
	const rawFile = path.join(dir, 'notjev-images.raw'), labelFile = path.join(dir, 'notjev-labels.txt');
	if (fs.existsSync(rawFile) && fs.existsSync(labelFile)) return { rawFile, labelFile };
	const script = `import pickle,sys
b=pickle.load(open(sys.argv[1],'rb'),encoding='bytes')
data,labels=b[b'data'],b[b'labels']
out=bytearray()
for i in range(len(labels)):
    p=data[i]
    for y in range(32):
        for x in range(32):
            out+=bytes((p[(y*32+x)], p[(1024)+(y*32+x)], p[(2048)+(y*32+x)]))
open(sys.argv[2],'wb').write(out)
open(sys.argv[3],'w').write(' '.join(str(l) for l in labels))`;
	const r = spawnSync('python3', ['-c', script, path.join(dir, 'test_batch'), rawFile, labelFile]);
	if (r.status) throw new Error('vision-animals: python3 conversion failed: ' + r.stderr.toString());
	return { rawFile, labelFile };
}

async function main() {
	const baseUrl = args.baseUrl || process.env.NOTJEV_BASE_URL;
	if (!baseUrl || !args.model) throw new Error('vision-animals: pass baseUrl= and model=');
	if (!args.dir) throw new Error('vision-animals: pass dir= pointing at cifar-10-batches-py (extracted test_batch)');
	const n = Number(args.n || 150), seed = Number(args.seed || 42);
	const { rawFile, labelFile } = prepare(args.dir);
	const data = fs.readFileSync(rawFile);
	const labels = fs.readFileSync(labelFile, 'utf8').trim().split(/\s+/).map(Number);
	if (data.length !== labels.length * 32 * 32 * 3) throw new Error('vision-animals: raw/label mismatch');

	const rand = mulberry32(seed);
	const picks = [], used = new Set();
	while (picks.length < n) { const i = Math.floor(rand() * labels.length); if (!used.has(i)) { used.add(i); picks.push(i); } }

	const service = createDecisionService({
		backend: createHttpContextBackend({ baseUrl, model: args.model, timeoutMs: Number(args.timeout || 120000) }),
		concurrency: 2, timeoutMs: Number(args.timeout || 120000),
	});
	async function one(index) {
		const label = CLASSES[labels[index]];
		const r = await service.decide({
			context: { type: 'fresh', messages: [{ role: 'user', content: [
				{ type: 'text', text: 'Here is a low-resolution colour photograph.' },
				{ type: 'image_url', image_url: { url: photoPng(data, index) } },
			] }] },
			questions: [{ id: 'object', question: 'the main object shown in the photo', options: CLASSES, theta: 0.5 }],
		});
		const row = r.results[0];
		return { index, label, status: row.status, choice: row.choice || null, p1: row.p1 ?? null,
			coverage: row.coverage ?? null, correct: row.choice === label };
	}

	const started = Date.now();
	const rows = [];
	for (let k = 0; k < picks.length; k += 2) for (const p of picks.slice(k, k + 2).map(one)) rows.push(await p);
	await service.close();
	rows.sort(( a, b ) => a.index - b.index);

	const decided = rows.filter(( r ) => r.status === 'decided');
	const hits = rows.filter(( r ) => r.choice === r.label);
	const byClass = {};
	for (const c of CLASSES) { const sub = rows.filter(( r ) => r.label === c );
		byClass[c] = { n: sub.length, correct: sub.filter(( r ) => r.correct).length }; }
	const report = {
		at: new Date().toISOString(), set: 'CIFAR-10 test set', n: rows.length, seed,
		model: args.model, baseUrl, theta: 0.5, elapsedMs: Date.now() - started,
		accuracyRaw: +(hits.length / rows.length).toFixed(4),
		decided: decided.length, undecided: rows.length - decided.length,
		precisionAmongDecided: decided.length ? +(hits.length / decided.length).toFixed(4) : null,
		coverageMin: +Math.min(...rows.map(( r ) => r.coverage ?? 1)).toFixed(4),
		p1MedianAmongDecided: +(decided.map(( r ) => r.p1).filter(p => p !== null).sort(( a, b ) => a - b)[Math.floor(decided.length / 2)] || 0).toFixed(4),
		byClass,
		errorsAmongDecided: decided.filter(( r ) => !r.correct ).map(( r ) => ({ label: r.label, said: r.choice, p1: +String(r.p1) })),
		undecided: rows.filter(( r ) => r.status !== 'decided' ).map(( r ) => ({ label: r.label, top: r.choice, p1: +String(r.p1) })),
	};
	if (args.out) fs.writeFileSync(args.out, JSON.stringify(report, null, 2) + '\n');
	console.log(JSON.stringify(report, null, 2));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
