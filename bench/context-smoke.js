#!/usr/bin/env node
'use strict';

// Real model smoke/measurement, opt-in. Never run by npm test. No model downloads.
const fs = require('node:fs');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { createDecisionService } = require('../lib/service');

function imageData(rgb) {
	function crc(bytes) { let c = -1; for (const byte of bytes) { c ^= byte; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ -1) >>> 0; }
	function chunk(type, data) {
		const tag = Buffer.from(type), n = Buffer.alloc(4), sum = Buffer.alloc(4);
		n.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([tag, data])));
		return Buffer.concat([n, tag, data, sum]);
	}
	const size = 128, header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
	const raw = Buffer.alloc(size * (1 + size * 3));
	for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) for (let c = 0; c < 3; c++) raw[y * (1 + size * 3) + 1 + x * 3 + c] = rgb[c];
	return 'data:image/png;base64,' + Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

async function main() {
	const args = Object.fromEntries(process.argv.slice(2).map(v => { const i = v.indexOf('='); return [v.slice(0, i), v.slice(i + 1)]; }));
	const native = args.backend === 'native';
	const model = args.model;
	if (!model) throw new Error('Use backend=native model=/path/model.gguf or backend=http model=alias baseUrl=http://host:port');
	const backend = native
		? await require('../lib/context-native').createNativeContextBackend({ modelPath: model, gpu: 'cuda', requireGpu: true, contextSize: 8192 })
		: require('../lib/context-http').createHttpContextBackend({ baseUrl: args.baseUrl, model, timeoutMs: 120000 });
	const service = createDecisionService({ backend, ownsBackend: true, concurrency: 2, timeoutMs: 120000 });
	const report = { at: new Date().toISOString(), backend: args.backend, model, info: backend.info || null, runs: [] };
	const question = { id: 'code', question: 'What is the secret code word specified in the context?', options: ['ORANGE', 'BLUE', 'UNKNOWN'], theta: 0.1 };
	try {
		const padding = 'This is background information, not a code word. '.repeat(160);
		const a = service.putContext({ type: 'messages', messages: [{ role: 'user', content: padding + '\nThe secret code word is ORANGE.' }] });
		const b = service.putContext({ type: 'messages', messages: [{ role: 'user', content: padding + '\nThe secret code word is BLUE.' }] });
		for (const [name, ref, expected] of [['cold', a.ref, 'ORANGE'], ['warm', a.ref, 'ORANGE'], ['other', b.ref, 'BLUE'], ['restore', a.ref, 'ORANGE']]) {
			const start = Date.now();
			const r = await service.decide({ context: { type: 'snapshot', ref }, questions: [question] });
			report.runs.push({ name, elapsedMs: Date.now() - start, ...r.results[0] });
			assert.equal(r.results[0].choice, expected, JSON.stringify(r));
		}
		const parallel = await Promise.all([a, b].map(s => service.decide({ context: { type: 'snapshot', ref: s.ref }, questions: [question] })));
		assert.deepEqual(parallel.map(r => r.results[0].choice), ['ORANGE', 'BLUE']);
		report.parallelIsolation = true;
		if (!native) {
			for (const [color, rgb] of [['RED', [255,0,0]], ['BLUE', [0,0,255]]]) {
				const r = await service.decide({ context: { type: 'fresh', messages: [{ role: 'user', content: [
					{ type: 'text', text: 'Examine this image.' }, { type: 'image_url', image_url: { url: imageData(rgb) } }
				] }] }, questions: [{ id: 'color', question: 'Which color fills the image?', options: ['RED', 'BLUE', 'GREEN'], theta: 0.1 }] });
				report.runs.push({ name: 'vision-' + color, ...r.results[0] });
				assert.equal(r.results[0].choice, color, JSON.stringify(r));
			}
		}
		report.ok = true;
	} catch (e) { report.ok = false; report.error = e.message; process.exitCode = 1; }
	finally { await service.close(); }
	if (args.out) fs.writeFileSync(args.out, JSON.stringify(report, null, 2) + '\n');
	console.log(JSON.stringify(report, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
