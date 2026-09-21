'use strict';
/**
 * THE README, EXECUTED.
 *
 * Every ```js and ```bash block of README.md is run AS IT IS WRITTEN, in order, in one directory,
 * against a fake `chat/completions` — exactly what a reader does when they follow the page from top
 * to bottom (the `run.json` written by one block is read by the next). The package is reached
 * through `node_modules/notjev` and the CLI through `PATH`, so the examples say `require('notjev')`
 * and `notjev …` like a user's would.
 *
 * ```sh blocks are the server-side ones (vLLM, llama.cpp, Ollama, npm install): they start other
 * people's daemons and are deliberately NOT run here. The count of both kinds is asserted, so a
 * README that loses a fence, or that grows an unrun example, fails this test instead of rotting.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { startFake, chatResponse, lp } = require('./helpers/fake-server');

const ROOT = path.join(__dirname, '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

/** Fenced blocks, with their info string and their line number (for a readable failure). */
function blocks( md ) {
	const out = [];
	const lines = md.split('\n');
	let cur = null;
	lines.forEach(( l, i ) => {
		const m = /^```(\S*)\s*$/.exec(l);
		if ( m && !cur ) { cur = { lang: m[1], line: i + 1, body: [] }; return; }
		if ( m && cur ) { out.push(Object.assign(cur, { body: cur.body.join('\n') })); cur = null; return; }
		if ( cur ) cur.body.push(l);
	});
	return out;
}

/** The fake answers any menu: strong mass on the FIRST letter, some on the second, a little outside. */
function answerFor( body ) {
	const content = (body && body.messages && body.messages[body.messages.length - 1].content) || '';
	const letters = (content.match(/^[A-Z]\. /gm) || []).map(( s ) => s[0] );
	if ( !letters.length ) return chatResponse([]);
	const pairs = [[letters[0], 0.95]];
	if ( letters[1] ) pairs.push([letters[1], 0.03]);
	for ( const l of letters.slice(2) ) pairs.push([l, 0.002]);
	pairs.push(['The', 0.01]);
	return chatResponse(lp(pairs));
}

describe('README — every example runs as written', () => {
	let fake, dir, env, all, runnable;

	before(async () => {
		fake = await startFake(( body ) => answerFor(body) );
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notjev-readme-'));
		fs.mkdirSync(path.join(dir, 'node_modules'));
		fs.symlinkSync(ROOT, path.join(dir, 'node_modules', 'notjev'), 'dir');
		fs.mkdirSync(path.join(dir, 'bin'));
		fs.symlinkSync(path.join(ROOT, 'bin', 'notjev.js'), path.join(dir, 'bin', 'notjev'));
		env = Object.assign({}, process.env, {
			PATH           : path.join(dir, 'bin') + path.delimiter + process.env.PATH,
			NOTJEV_BASE_URL: fake.url,
			NOTJEV_MODEL   : 'fake-model',
			NOTJEV_API_KEY : '',
			NOTJEV_THETA   : '',
		});
		all = blocks(README);
		runnable = all.filter(( b ) => b.lang === 'js' || b.lang === 'bash' );
	});

	after(async () => { await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });

	test('the README carries the examples this test claims to cover', () => {
		assert.ok(runnable.length >= 9, 'only ' + runnable.length + ' runnable blocks found — a fence has '
			+ 'been lost, or the examples have been deleted: this test would then pass by covering nothing');
		const notRun = all.filter(( b ) => b.lang && b.lang !== 'js' && b.lang !== 'bash' );
		assert.deepStrictEqual([...new Set(notRun.map(( b ) => b.lang ))], ['sh'],
			'a block carries a language this harness neither runs nor declares as skipped');
		for ( const b of notRun )
			assert.ok(/vllm|llama-server|npm install|ollama|export NOTJEV|npm test|npm run lint|notjev decide --no-template/
				.test(b.body), 'an ```sh block at line ' + b.line + ' is not a server-side command — it should '
				+ 'either be run (```bash) or be justified here');
	});

	test('every ```js and ```bash example exits 0, in order, in one directory', async () => {
		for ( const b of runnable ) {
			const file = path.join(dir, 'readme-' + b.line + (b.lang === 'js' ? '.js' : '.sh'));
			fs.writeFileSync(file, b.body);
			const r = await new Promise(( resolve ) => {
				execFile(b.lang === 'js' ? process.execPath : '/bin/bash', [file],
					{ cwd: dir, env: env, timeout: 30000 },
					( err, stdout, stderr ) => resolve({ code: err ? (err.code === undefined ? 1 : err.code) : 0,
						stdout: stdout, stderr: stderr }) );
			});
			assert.strictEqual(r.code, 0, 'README block at line ' + b.line + ' (```' + b.lang + ') FAILED with '
				+ 'exit ' + r.code + '.\n--- block ---\n' + b.body + '\n--- stdout ---\n' + r.stdout
				+ '\n--- stderr ---\n' + r.stderr);
		}
	});

	test('the fingerprinted numbers quoted in the README are the ones the code carries', () => {
		const R = require('../lib/readout');
		assert.ok(README.includes('`low` < 0.5 <= `med` < 0.75 <= `high` < 0.9 <= `certain`'));
		assert.deepStrictEqual(R.BAND_EDGES, [0.5, 0.75, 0.9], 'the README states the band edges: they must be these');
		assert.ok(README.includes('26 options maximum'));
		assert.strictEqual(R.MAX_OPTIONS, 26);
		assert.ok(README.includes('Node >= 20'));
		assert.strictEqual(require('../package.json').engines.node, '>=20');
		assert.strictEqual(require('../package.json').license, undefined,
			'the README says the licence is still the owner\'s call — a license field would contradict it');
		assert.strictEqual(require('../package.json').private, true);
	});
});
