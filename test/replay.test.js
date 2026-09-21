'use strict';
/**
 * THE REPLAY — the same reading, offline.
 *
 * The distribution is a small object. Recorded once, every later question about the decision rule
 * (another theta, other edges, another truth column) is answered with NO GPU, by the SAME reader
 * that runs in flight. These tests hold that equality: what a replay says must be what the live
 * call said, to the last digit.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const { replay, report } = require('../lib/replay');
const { createClient, readResponse } = require('../lib/client');
const { startFake } = require('./helpers/fake-server');

const REC = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'recording.json'), 'utf8'));

describe('replay — a recorded run, re-read without a GPU', () => {

	test('A LIVE CALL AND ITS REPLAY RETURN THE SAME NUMBERS, to the last digit', async () => {
		const row = REC.results[1];
		const fake = await startFake(() => row.resp );
		try {
			const live = await createClient({ baseUrl: fake.url, model: 'm', env: {}, retries: 0 })
				.decide({ state: 'S', question: 'q', options: row.options, theta: 0.5 });
			const off = readResponse(row.resp, { options: row.options, theta: 0.5 });
			for ( const k of ['choice', 'top', 'p1', 'p2', 'margin', 'band', 'prior', 'coverage',
				'exactMass', 'spacedMass', 'degraded', 'undecided'] )
				assert.deepStrictEqual(off[k], live[k],
					'THE REPLAY DIVERGES FROM THE LIVE CALL ON `' + k + '` (' + JSON.stringify(off[k]) + ' vs '
					+ JSON.stringify(live[k]) + ') — then a recorded campaign measures something the production '
					+ 'does not do, and every published number is about the harness');
		} finally { await fake.close(); }
	});

	test('a replay returns one row per recorded question, with the truth column the CALLER names', () => {
		const { rows, meta } = replay(REC, { theta: 0, truth: 'gold' });
		assert.strictEqual(rows.length, 5);
		assert.deepStrictEqual(rows.map(( r ) => r.top ), ['SAME', 'SAME', 'OTHER', 'SAME', 'SAME']);
		assert.deepStrictEqual(rows.map(( r ) => r.correct ), [true, false, true, true, true]);
		assert.strictEqual(meta.degraded, 0, 'r5 carries 1 % + 1 % of option mass: low coverage is NOT degraded');
		assert.ok(Math.abs(rows[4].coverage - 0.02) < 1e-9,
			'coverage must stay the RAW option mass — it is the signal that the model meant something else');
		assert.strictEqual(rows[4].band, 'med', 'renormalised, 0.01/0.02 is a coin flip: the band says med, '
			+ 'and the coverage says why the band cannot be trusted');
	});

	test('THETA CHANGES THE ABSTENTION, NOT THE READING — the same recording, two regimes', () => {
		const at0 = replay(REC, { theta: 0, truth: 'gold' }).rows;
		const at5 = replay(REC, { theta: 0.5, truth: 'gold' }).rows;
		assert.deepStrictEqual(at0.map(( r ) => r.p1 ), at5.map(( r ) => r.p1 ),
			'theta changed the probabilities — then it is not an abstention rule, it is a different reading');
		assert.deepStrictEqual(at0.map(( r ) => r.undecided ), [false, false, false, false, false]);
		assert.deepStrictEqual(at5.map(( r ) => r.undecided ), [false, true, false, true, true],
			'at theta = 0.5 exactly the three rows whose margin is under 0.5 must abstain (0.061, 0.225, 0.000) '
			+ 'and no other');
	});

	test('the report carries the ACCURACY WITH ITS TWO ARMS, the ECE, the curve and the bands', () => {
		const { rows } = replay(REC, { theta: 0, truth: 'gold' });
		const rep = report(rows, { positive: 'SAME' });
		assert.strictEqual(rep.n, 5);
		assert.strictEqual(rep.accuracy.accuracy, 0.8);
		assert.strictEqual(rep.accuracy.nullArm.klass, 'SAME');
		assert.strictEqual(rep.accuracy.nullArm.accuracy, 0.6,
			'without the null arm, 0.8 would look like a result; against 0.6 it is worth +0.2');
		assert.strictEqual(rep.accuracy.oracle.accuracy, 1);
		assert.strictEqual(rep.sweep[0].coverage, 1, 'theta = 0 decides everything');
		assert.ok(rep.sweep.find(( s ) => s.theta === 0.5 ).precision === 1,
			'at theta = 0.5 the only error of this recording is under the margin');
		assert.strictEqual(rep.f1.tp, 3, 'at theta = 0 the curve reads on `top`, so the three SAME tops count');
		assert.strictEqual(rep.f1.fp, 1, 'the one wrong row is a false SAME — and it is the error that costs');
		assert.ok(rep.ece.ece !== null);
	});

	test('NEGATIVE CONTROL — a recording without `results`, or a row without a menu, is REFUSED and NAMED', () => {
		assert.throws(() => replay({ results: [] }), ( e ) => e.code === 'NOTJEV_EMPTY_RECORD',
			'a replay of nothing would report a perfect run on an empty set');
		assert.throws(() => replay({ results: [{ resp: REC.results[0].resp }] }),
			( e ) => e.code === 'NOTJEV_NO_OPTIONS',
			'without the menu, the letters cannot be mapped back to codes — a silent default would invent a codomain');
	});

	test('NEGATIVE CONTROL — a recording whose responses carry NO distribution replays as degraded, '
		+ 'never as an accuracy', () => {
		const flat = { results: REC.results.map(( r ) => ({ id: r.id, options: r.options, gold: r.gold,
			resp: { choices: [{ message: { content: 'A' } }] } }) ) };
		const { rows, meta } = replay(flat, { theta: 0, truth: 'gold' });
		assert.strictEqual(meta.degraded, 5, 'responses without logprobs replayed as if they carried a verdict');
		assert.deepStrictEqual(rows.map(( r ) => r.choice ), [null, null, null, null, null],
			'a verdict was produced from a response that carried NO distribution');
		const rep = report(rows, {});
		assert.strictEqual(rep.accuracy.accuracy, 0.6,
			'the `top` of a uniform is the first option, so the accuracy equals the null arm EXACTLY — that '
			+ 'equality is the signature of a dead measurement, and it is why `degraded` is published beside it');
		assert.strictEqual(rep.accuracy.nullArm.accuracy, 0.6);
	});
});
