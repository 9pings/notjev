'use strict';
/**
 * @file lib/replay.js — RE-READ A RECORDED RUN, WITH NO GPU AT ALL.
 *
 * A readout call is cheap, but it is not free, and it is not reproducible on someone else's card.
 * The distribution, however, is a SMALL object: record it once, and every later question about the
 * decision rule — another theta, other band edges, another truth column, another metric — is
 * answered offline, by the same reader that runs in flight (`readResponse`). That is the whole
 * point of keeping the reading pure.
 *
 * A recording is `{ results: [{ id?, options, resp, ms?, <truth fields> }] }` or just that array.
 * Nothing here knows what the truth column is called: the caller names it (`truth`).
 */

const { readResponse } = require('./client');
const metrics = require('./metrics');

/**
 * @param record `{ results: [...] }` or `[...]`
 * @param opts   `{ theta?, edges?, truth?, options?, positive? }`
 *               `truth` = the name of the field holding the expected code (e.g. `'gold'`);
 *               `options` = the codomain, when the recording does not carry one per row.
 * @returns `{ rows, meta }` — `rows` are readable one per line and comparable to another tool's.
 */
function replay( record, opts ) {
	const o = opts || {};
	const results = Array.isArray(record) ? record : (record && record.results) || [];
	if ( !results.length )
		throw Object.assign(new Error('notjev.replay: the recording carries no `results`. A replay of '
			+ 'nothing would report a perfect run on an empty set.'), { code: 'NOTJEV_EMPTY_RECORD' });
	const rows = results.map(( x, i ) => {
		const options = x.options || o.options;
		if ( !options )
			throw Object.assign(new Error('notjev.replay: row ' + (x.id || i) + ' carries no `options`, and '
				+ 'none was passed. The letters cannot be mapped back to codes without the menu.'),
			{ code: 'NOTJEV_NO_OPTIONS' });
		const r = readResponse(x.resp, {
			options: options, theta: o.theta, edges: o.edges, ms: x.ms,
		});
		const expected = o.truth ? x[o.truth] : undefined;
		return {
			id      : x.id !== undefined ? x.id : i,
			family  : x.family,
			choice  : r.choice,
			top     : r.top,
			value   : r.value,
			p1      : r.p1,
			p2      : r.p2,
			margin  : r.margin,
			band    : r.band,
			prior   : r.prior,
			coverage: r.coverage,
			spaced  : r.spacedMass,
			degraded: r.degraded,
			undecided: r.undecided,
			theta   : r.theta,
			expected: expected,
			correct : expected === undefined ? undefined : r.top === expected,
			ms      : x.ms === undefined ? null : x.ms,
		};
	});
	return {
		rows: rows,
		meta: {
			n       : rows.length,
			model   : (record && record.model) || null,
			at      : (record && record.at) || null,
			truth   : o.truth || null,
			theta   : rows.length ? rows[0].theta : null,
			degraded: rows.filter(( r ) => r.degraded ).length,
			coverage: rows.reduce(( a, r ) => a + r.coverage, 0 ) / rows.length,
			spaced  : rows.reduce(( a, r ) => a + r.spaced, 0 ) / rows.length,
		},
	};
}

/**
 * THE REPORT OF A REPLAY — accuracy WITH its two arms, ECE, the coverage x precision curve, the
 * bands. Never an accuracy alone: without the null arm a number has no scale.
 */
function report( rows, opts ) {
	const o = opts || {};
	const withTruth = rows.filter(( r ) => r.expected !== undefined && r.expected !== null );
	const scored = withTruth.map(( r ) => ({ p1: r.p1, margin: r.margin, choice: r.top, expected: r.expected, band: r.band }) );
	return {
		n        : rows.length,
		withTruth: withTruth.length,
		accuracy : metrics.accuracy(scored),
		ece      : metrics.ece(scored, o.bins || 10),
		sweep    : metrics.sweep(scored, o.thetas || [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]),
		bands    : metrics.byBand(scored),
		f1       : o.positive ? metrics.f1(scored, o.positive) : null,
		coverage : rows.reduce(( a, r ) => a + r.coverage, 0 ) / rows.length,
		degraded : rows.filter(( r ) => r.degraded ).length,
		spaced   : rows.reduce(( a, r ) => a + r.spaced, 0 ) / rows.length,
	};
}

module.exports = { replay, report };
