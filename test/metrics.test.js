'use strict';
/** THE PUBLISHED MEASUREMENTS — a number without its arms and its empty buckets is not a measurement. */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const M = require('../lib/metrics');

describe('metrics — the curve, the calibration, the arms', () => {

	test('the coverage x precision CURVE reads at increasing theta, and theta = 0 is the arm WITHOUT abstention', () => {
		const rows = [
			{ margin: 0.95, choice: 'SAME', expected: 'SAME' },
			{ margin: 0.60, choice: 'SAME', expected: 'SAME' },
			{ margin: 0.10, choice: 'SAME', expected: 'OTHER' },
			{ margin: 0.05, choice: 'OTHER', expected: 'SAME' },
		];
		const s = M.sweep(rows, [0, 0.5, 0.9]);
		assert.strictEqual(s[0].coverage, 1, 'theta = 0: everything is decided');
		assert.strictEqual(s[0].precision, 0.5, '2 right out of 4');
		assert.strictEqual(s[1].decided, 2);
		assert.strictEqual(s[1].precision, 1, 'at theta = 0.5 both errors are under the margin');
		assert.strictEqual(s[2].decided, 1);
	});

	test('NEGATIVE CONTROL — a sweep on rows where the margin does NOT correlate with correctness buys '
		+ 'nothing: the precision stays flat', () => {
		const rows = [
			{ margin: 0.99, choice: 'A', expected: 'B' },
			{ margin: 0.98, choice: 'A', expected: 'A' },
			{ margin: 0.10, choice: 'A', expected: 'B' },
			{ margin: 0.05, choice: 'A', expected: 'A' },
		];
		const s = M.sweep(rows, [0, 0.9]);
		assert.strictEqual(s[0].precision, 0.5);
		assert.strictEqual(s[1].precision, 0.5,
			'abstention improved the precision on rows built so that it cannot — then the curve is measuring '
			+ 'the instrument, not the model');
	});

	test('the ECE returns its EMPTY buckets, and `null` on an empty set (EMPTY MEASURE != 0)', () => {
		const e = M.ece([{ p1: 0.95, correct: true }, { p1: 0.95, correct: true }], 10);
		assert.strictEqual(e.bins.length, 10);
		assert.strictEqual(e.bins[0].n, 0, 'an empty bucket is published: hiding it would suggest a uniform '
			+ 'coverage the measurement does not have');
		assert.ok(e.ece < 0.06);
		assert.strictEqual(M.ece([], 10).ece, null, 'an ECE of 0 over 0 rows would be a false green');
	});

	test('NEGATIVE CONTROL — an OVER-CONFIDENT and wrong responder returns a high ECE', () => {
		const rows = []; for ( let i = 0; i < 10; i++ ) rows.push({ p1: 0.99, correct: false });
		assert.ok(M.ece(rows, 10).ece > 0.9,
			'a model at 0.99 confidence and 0 % accuracy returns a low ECE — the measurement does not bite');
	});

	test('`correct` is derived from choice/expected when it is not given', () => {
		const e = M.ece([{ p1: 0.95, choice: 'A', expected: 'A' }, { p1: 0.95, choice: 'A', expected: 'B' }], 10);
		assert.strictEqual(e.bins[9].acc, 0.5, 'the derived correctness must feed the calibration like a given one');
		assert.strictEqual(M.isCorrect({ p1: 1 }), null, 'without truth, correctness is UNKNOWN, not false');
	});

	test('the F1 of an absent class is `null`, not 0', () => {
		assert.strictEqual(M.f1([{ choice: 'OTHER', expected: 'OTHER' }], 'SAME').f1, null,
			'a 0 on a class never seen would read as a failure, when it is an EMPTY MEASURE');
		const f = M.f1([{ choice: 'SAME', expected: 'SAME' }, { choice: 'SAME', expected: 'OTHER' }], 'SAME');
		assert.strictEqual(f.p, 0.5);
		assert.strictEqual(f.r, 1);
	});

	test('THE NULL ARM AND THE ORACLE ARM COME WITH EVERY ACCURACY — without them a bar has no scale', () => {
		const rows = [];
		for ( let i = 0; i < 7; i++ ) rows.push({ choice: 'OTHER', expected: 'OTHER' });
		for ( let i = 0; i < 3; i++ ) rows.push({ choice: 'OTHER', expected: 'SAME' });
		const a = M.accuracy(rows);
		assert.strictEqual(a.accuracy, 0.7);
		assert.strictEqual(a.nullArm.klass, 'OTHER');
		assert.strictEqual(a.nullArm.accuracy, 0.7,
			'the null arm must reach the same 0.7: a responder that always says the majority class is exactly '
			+ 'what this one does — an accuracy alone would have looked like a result');
		assert.strictEqual(a.oracle.accuracy, 1);
	});

	test('NEGATIVE CONTROL — the null arm is `null` on rows without truth, and the accuracy too', () => {
		const a = M.accuracy([{ choice: 'A' }, { choice: 'B' }]);
		assert.strictEqual(a.nullArm, null, 'a majority class was computed over a truth column that does not exist');
		assert.strictEqual(a.accuracy, null, 'an accuracy of 0 over 0 rows with truth would be a false red');
	});

	test('the bands are counted with their accuracy, and an empty band is an EMPTY MEASURE', () => {
		const b = M.byBand([
			{ band: 'certain', p1: 0.95, choice: 'A', expected: 'A' },
			{ band: 'certain', p1: 0.99, choice: 'A', expected: 'A' },
			{ band: 'low', p1: 0.4, choice: 'A', expected: 'B' },
		]);
		const certain = b.find(( x ) => x.band === 'certain' );
		assert.strictEqual(certain.n, 2);
		assert.strictEqual(certain.accuracy, 1);
		const med = b.find(( x ) => x.band === 'med' );
		assert.strictEqual(med.n, 0);
		assert.strictEqual(med.accuracy, null, 'an empty band must read as EMPTY MEASURE, not as 0 % accuracy');
	});
});
