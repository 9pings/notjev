'use strict';
/**
 * @file lib/metrics.js — WHAT YOU PUBLISH INSTEAD OF A THRESHOLD.
 *
 * A readout returns a probability, so it can be CALIBRATED, and it can ABSTAIN. Neither of those
 * is worth anything until it is measured on your own questions:
 *   - `ece`   : is `p1` the frequency of being right? (a confidence that is not one is a lie)
 *   - `sweep` : the coverage x precision curve — the actual output of a campaign. theta is read
 *               off it; it is never decreed in a comment.
 *   - `f1`    : the per-class score, for the class whose errors cost something.
 *   - `nullArm` / `oracleArm` : without them a bar has no scale. The null arm says what you get
 *               WITHOUT understanding anything (always answer the majority class); the oracle arm
 *               says what a perfect responder gets on YOUR rows. A bar that the null arm already
 *               clears measures nothing; a bar above the oracle kills a healthy mechanism.
 *
 * ROW SHAPE: `{ p1, margin, choice, expected, correct? }`. `correct` is derived from
 * `choice === expected` when it is not given — so a caller can feed either.
 * No language, no label, no threshold is hardcoded here: the classes are the caller's codes.
 */

/** `correct` as given, or derived from choice/expected. `null` when neither is available. */
function isCorrect( r ) {
	if ( !r ) return null;
	if ( r.correct !== undefined ) return !!r.correct;
	if ( r.expected === undefined || r.choice === undefined ) return null;
	return r.choice === r.expected;
}

/**
 * EXPECTED CALIBRATION ERROR, over `bins` equal buckets of `p1`.
 *
 * @param rows `[{ p1, correct | choice+expected }]`
 * @returns `{ ece, bins: [{ lo, hi, n, conf, acc }], n }` — EMPTY buckets are returned (n = 0):
 *          hiding them would suggest a uniform coverage the measurement does not have.
 *          `ece` is `null` on an empty set: an ECE of 0 over 0 rows would be a false green.
 */
function ece( rows, bins ) {
	const k = bins || 10;
	const buckets = [];
	for ( let i = 0; i < k; i++ ) buckets.push({ lo: i / k, hi: (i + 1) / k, n: 0, sp: 0, sc: 0 });
	const xs = (rows || []).filter(( r ) => r && isFinite(r.p1) );
	for ( const r of xs ) {
		let i = Math.min(k - 1, Math.floor(Number(r.p1) * k));
		if ( i < 0 ) i = 0;
		buckets[i].n++;
		buckets[i].sp += Number(r.p1);
		buckets[i].sc += isCorrect(r) ? 1 : 0;
	}
	let e = 0;
	const out = buckets.map(( s ) => {
		const conf = s.n ? s.sp / s.n : 0, acc = s.n ? s.sc / s.n : 0;
		if ( s.n ) e += (s.n / xs.length) * Math.abs(acc - conf);
		return { lo: s.lo, hi: s.hi, n: s.n, conf: conf, acc: acc };
	});
	return { ece: xs.length ? e : null, bins: out, n: xs.length };
}

/**
 * THE COVERAGE x PRECISION CURVE — what you publish instead of a threshold.
 *
 * @param rows   `[{ margin, choice, expected }]`
 * @param thetas the thetas to sweep
 * @returns `[{ theta, decided, coverage, right, precision }]` — precision is computed **over the
 *          decided rows only** (the question is "when it commits, is it right?"); coverage says at
 *          what price. `theta = 0` is the arm WITHOUT abstention.
 */
function sweep( rows, thetas ) {
	const xs = (rows || []).filter(Boolean);
	const ths = thetas || [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
	return ths.map(( t ) => {
		const dec = xs.filter(( r ) => Number(r.margin) >= t );
		const right = dec.filter(( r ) => isCorrect(r) ).length;
		return {
			theta    : t,
			decided  : dec.length,
			coverage : xs.length ? dec.length / xs.length : null,
			right    : right,
			precision: dec.length ? right / dec.length : null,
		};
	});
}

/** F1 of a NAMED positive class — `null` when the class exists neither in truth nor in prediction
 *  (that is an EMPTY measurement, not a 0). */
function f1( rows, positive ) {
	const xs = (rows || []).filter(Boolean);
	const tp = xs.filter(( r ) => r.choice === positive && r.expected === positive ).length;
	const fp = xs.filter(( r ) => r.choice === positive && r.expected !== positive ).length;
	const fn = xs.filter(( r ) => r.choice !== positive && r.expected === positive ).length;
	if ( !tp && !fp && !fn ) return { p: null, r: null, f1: null, tp: 0, fp: 0, fn: 0 };
	const p = (tp + fp) ? tp / (tp + fp) : 0;
	const r = (tp + fn) ? tp / (tp + fn) : 0;
	return { p: p, r: r, f1: (p + r) ? 2 * p * r / (p + r) : 0, tp: tp, fp: fp, fn: fn };
}

/**
 * THE NULL ARM — always answer the majority class of the truth column.
 * Publish it NEXT TO any accuracy: an accuracy below it is worse than knowing nothing, and an
 * accuracy just above it has bought nothing.
 *
 * @returns `{ klass, n, total, accuracy, counts }`, or `null` when there is no truth at all.
 */
function nullArm( rows ) {
	const xs = (rows || []).filter(( r ) => r && r.expected !== undefined && r.expected !== null );
	if ( !xs.length ) return null;
	const counts = {};
	for ( const r of xs ) counts[r.expected] = (counts[r.expected] || 0) + 1;
	const klass = Object.keys(counts).sort(( a, b ) => counts[b] - counts[a] )[0];
	return { klass: klass, n: counts[klass], total: xs.length, accuracy: counts[klass] / xs.length, counts: counts };
}

/**
 * THE ORACLE ARM — a perfect responder ON THESE ROWS. It is 1 by construction on accuracy, and it
 * is returned so that a bar is never written without its ceiling: any precision < 1 at theta = 0
 * measures the gap to perfect, not the difficulty of the set.
 */
function oracleArm( rows ) {
	const xs = (rows || []).filter(( r ) => r && r.expected !== undefined && r.expected !== null );
	return { total: xs.length, accuracy: xs.length ? 1 : null };
}

/** The accuracy of the rows themselves, with the two arms beside it — never one without the others. */
function accuracy( rows ) {
	const xs = (rows || []).filter(( r ) => r && r.expected !== undefined && r.expected !== null );
	const right = xs.filter(( r ) => isCorrect(r) ).length;
	return {
		n       : xs.length,
		right   : right,
		accuracy: xs.length ? right / xs.length : null,
		nullArm : nullArm(rows),
		oracle  : oracleArm(rows),
	};
}

/** The count of rows per band, with their accuracy — the band is what is portable between engines. */
function byBand( rows, bands ) {
	const xs = (rows || []).filter(Boolean);
	const names = bands || ['low', 'med', 'high', 'certain'];
	return names.map(( b ) => {
		const ys = xs.filter(( r ) => r.band === b );
		const withTruth = ys.filter(( r ) => isCorrect(r) !== null );
		return {
			band    : b,
			n       : ys.length,
			p1      : ys.length ? ys.reduce(( a, r ) => a + Number(r.p1), 0 ) / ys.length : null,
			accuracy: withTruth.length ? withTruth.filter(( r ) => isCorrect(r) ).length / withTruth.length : null,
		};
	});
}

module.exports = { ece, sweep, f1, nullArm, oracleArm, accuracy, byBand, isCorrect };
