'use strict';
/**
 * THE CLI — what a shell gets, including the EXIT CODE.
 *
 * The exit code is part of the contract: a verdict is 0, an abstention is 3, a degraded readout is
 * 4. A shell that cannot tell "it said SAME" from "it said nothing" would treat the abstention as a
 * verdict, which is exactly what the margin exists to prevent.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { startFake, chatResponse, lp } = require('./helpers/fake-server');

const BIN = path.join(__dirname, '..', 'bin', 'notjev.js');

function run( args, env ) {
	return new Promise(( resolve ) => {
		execFile(process.execPath, [BIN].concat(args), { env: Object.assign({}, process.env, env || {}) },
			( err, stdout, stderr ) => resolve({ code: err ? (err.code === undefined ? 1 : err.code) : 0,
				stdout: stdout, stderr: stderr }) );
	});
}

describe('cli — decide / noul / prompt / replay', () => {

	test('`decide --json` prints the whole decision and exits 0 on a verdict', async () => {
		const fake = await startFake(() => chatResponse(lp([['A', 0.96], ['B', 0.03], ['The', 0.01]])) );
		try {
			const r = await run(['decide', '--base-url', fake.url, '--model', 'm', '--state', 'S\n',
				'--question', 'verdict', '--option', 'SAME', '--option', 'OTHER', '--theta', '0.5', '--json']);
			assert.strictEqual(r.code, 0, r.stderr);
			const j = JSON.parse(r.stdout);
			assert.strictEqual(j.choice, 'SAME');
			assert.strictEqual(j.band, 'certain');
			assert.strictEqual(j.raw, undefined, '--json must not dump the server response unless --raw');
			assert.ok(/Question: verdict\nA\. SAME\nB\. OTHER$/.test(j.prompt));
		} finally { await fake.close(); }
	});

	test('NEGATIVE CONTROL — an abstention exits 3 and a degraded readout exits 4, they are NOT 0', async () => {
		const flat = await startFake(() => chatResponse(lp([['A', 0.55], ['B', 0.45]])) );
		const off = await startFake(() => chatResponse(lp([['The', 0.7], ['Both', 0.3]])) );
		try {
			const under = await run(['decide', '--base-url', flat.url, '--model', 'm', '--state', 'S',
				'--question', 'q', '--option', 'A1', '--option', 'B1', '--theta', '0.5']);
			assert.strictEqual(under.code, 3, 'an abstention exited ' + under.code + ' — a shell would read it '
				+ 'as a verdict, which is what the margin exists to prevent');
			assert.ok(/^UNDECIDED/.test(under.stdout));
			const deg = await run(['decide', '--base-url', off.url, '--model', 'm', '--state', 'S',
				'--question', 'q', '--option', 'A1', '--option', 'B1', '--theta', '0']);
			assert.strictEqual(deg.code, 4, 'a degraded readout exited ' + deg.code);
			assert.ok(/^DEGRADED/.test(deg.stdout));
			assert.ok(/NO option mass/.test(deg.stderr), 'the cause must be printed, not guessed');
		} finally { await flat.close(); await off.close(); }
	});

	test('`--option ID=description` puts the description in the menu, the code in the answer', async () => {
		const fake = await startFake(() => chatResponse(lp([['A', 0.96], ['B', 0.04]])) );
		try {
			const r = await run(['decide', '--base-url', fake.url, '--model', 'm', '--state', 'S',
				'--question', 'q', '--option', 'SAME=one entity', '--option', 'OTHER=two entities',
				'--theta', '0', '--json']);
			assert.strictEqual(JSON.parse(r.stdout).choice, 'SAME');
			assert.ok(/A\. SAME: one entity\nB\. OTHER: two entities$/.test(fake.requests[0].body.messages[0].content));
		} finally { await fake.close(); }
	});

	test('`noul --yes --no` takes the two options from the SHELL, and `--state <file>` reads the file', async () => {
		const fake = await startFake(() => chatResponse(lp([['B', 0.96], ['A', 0.04]])) );
		const f = path.join(os.tmpdir(), 'notjev-state-' + process.pid + '.txt');
		fs.writeFileSync(f, 'a state read from a file\n');
		try {
			const r = await run(['noul', '--base-url', fake.url, '--model', 'm', '--state', f,
				'--question', 'is it so?', '--yes', 'OUI', '--no', 'NON', '--theta', '0', '--json']);
			const j = JSON.parse(r.stdout);
			assert.strictEqual(j.choice, 'NON');
			assert.strictEqual(j.value, false);
			assert.ok(/Context:\na state read from a file\n/.test(fake.requests[0].body.messages[0].content),
				'the file content must go in as the state, verbatim');
		} finally { await fake.close(); fs.unlinkSync(f); }
	});

	test('`prompt` prints the EXACT string and sends NOTHING', async () => {
		const fake = await startFake(() => chatResponse(lp([['A', 1]])) );
		try {
			const r = await run(['prompt', '--base-url', fake.url, '--state', 'S\n', '--question', 'verdict',
				'--option', 'SAME', '--option', 'OTHER']);
			assert.strictEqual(r.code, 0);
			assert.strictEqual(r.stdout, 'Choose the correct option. Reply with only its letter.\n\nContext:\nS\n\n\n'
				+ 'Question: verdict\nA. SAME\nB. OTHER\n');
			assert.strictEqual(fake.requests.length, 0, '`prompt` called the server — it must be free and offline');
		} finally { await fake.close(); }
	});

	test('NEGATIVE CONTROL — `decide` without any `--option` is REFUSED (exit 1), it does not invent a menu', async () => {
		const r = await run(['decide', '--base-url', 'http://127.0.0.1:1', '--question', 'q', '--state', 'S']);
		assert.strictEqual(r.code, 1);
		assert.ok(/CLOSED codomain/.test(r.stderr), 'the refusal must say what is missing: ' + r.stderr);
	});

	test('`replay` re-reads a recording with no server at all, and prints the arms beside the accuracy', async () => {
		const rec = path.join(__dirname, 'fixtures', 'recording.json');
		const r = await run(['replay', rec, '--truth', 'gold', '--theta', '0', '--positive', 'SAME'],
			{ NOTJEV_BASE_URL: '', NOTJEV_MODEL: '' });
		assert.strictEqual(r.code, 0, r.stderr);
		const rows = r.stdout.split('\n').filter(( l ) => /^r\d/.test(l) );
		assert.strictEqual(rows.length, 5, 'one line per recorded question');
		assert.ok(/^r1\tSAME\t0\.969388/.test(rows[0]), rows[0]);
		assert.ok(/accuracy=0\.800000 \(4\/5\)  null-arm=0\.600000/.test(r.stdout),
			'the accuracy must be printed WITH its null arm — a number without its arm has no scale');
		assert.ok(/oracle=1\.000000/.test(r.stdout));
	});

	test('`help` and an unknown command both say what exists', async () => {
		const h = await run(['help']);
		assert.strictEqual(h.code, 0);
		assert.ok(/notjev decide/.test(h.stdout) && /exit  : 0 a verdict/.test(h.stdout));
		const bad = await run(['nope']);
		assert.strictEqual(bad.code, 1);
		assert.ok(/unknown command/.test(bad.stderr));
	});

	test('`serve` listens, answers, and points where it was told', async () => {
		const fake = await startFake(() => chatResponse(lp([['A', 0.96], ['B', 0.04]])) );
		const { spawn } = require('node:child_process');
		const port = 18787;
		const child = spawn(process.execPath, [BIN, 'serve', '--port', String(port), '--base-url', fake.url,
			'--model', 'm'], { env: Object.assign({}, process.env) });
		try {
			await new Promise(( resolve, reject ) => {
				const t = setTimeout(() => reject(new Error('serve did not start')), 5000);
				child.stdout.on('data', ( d ) => { if ( /notjev serve/.test(String(d)) ) { clearTimeout(t); resolve(); } });
			});
			const j = await (await fetch('http://127.0.0.1:' + port + '/v1/decide', { method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ state: 'S', theta: 0, questions: [{ question: 'q', options: ['A1', 'B1'] }] }) })).json();
			assert.strictEqual(j.results[0].choice, 'A1');
			assert.strictEqual(j.model, 'm');
		} finally { child.kill(); await fake.close(); }
	});
});
