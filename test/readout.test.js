'use strict';
/**
 * THE READOUT — the exact string that goes out, the distribution that comes back.
 *
 * WHAT THESE TESTS HOLD: the numbers published for this technique (0.947 agreement with the
 * generating arm over n = 1224, raw ECE 0.090, 70 ms/question on vLLM) hold ONLY for the exact
 * string the measuring campaign sent — "the prompt weighs more than the engine" (same engine,
 * 0.833 vs 0.733 on layout alone). The first test is therefore an IDENTITY test: the string this
 * library builds today must be, byte for byte, the one of the 2026-09-20 campaign. The three
 * fingerprints come from that campaign's jobs; the states they cover are committed here, so the
 * test depends on no outside path, and it falls if one character of the envelope moves.
 *
 * Every negative control below is NAMED: it states which sabotage it detects.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const RDT = require('../lib/readout');
const { chatResponse, completionsResponse } = require('./helpers/fake-server');

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'campaign-turns.json'), 'utf8'));
const sha = ( s ) => crypto.createHash('sha256').update(s).digest('hex');
const chat = ( pairs ) => chatResponse(pairs);
const compl = ( pairs ) => completionsResponse(pairs);

describe('readout — the exact string of the 2026-09-20 campaign', () => {

	test('THE REQUEST IS THE CAMPAIGN ONE, BYTE FOR BYTE (3 real states)', () => {
		assert.strictEqual(FIX.rows.length, 3, 'the fixture must carry the 3 campaign states');
		for ( const r of FIX.rows ) {
			const content = RDT.renderTurn({ state: r.state, question: r.question, options: r.options });
			assert.strictEqual(sha(content), r.sha256,
				'THE STRING SENT IS NO LONGER THE CAMPAIGN ONE (question ' + r.id + ') — the published '
				+ '0.947 / ECE 0.090 no longer apply to it. One character of the envelope (instruction, '
				+ '`Context:`, blank line, `Question: `, `A. `) has moved.');
		}
	});

	test('the layout is instruction · Context · state · Question · menu', () => {
		const c = RDT.renderTurn({ state: 'STATE\n', question: 'verdict', options: ['SAME', 'OTHER'] });
		assert.strictEqual(c,
			'Choose the correct option. Reply with only its letter.\n\nContext:\nSTATE\n\n\n'
			+ 'Question: verdict\nA. SAME\nB. OTHER');
	});

	test('NEGATIVE CONTROL — a TRIMMED state does NOT render the same string: the blank line measured '
		+ 'in the campaign really comes from the trailing newline of the state', () => {
		const withNl = RDT.renderTurn({ state: 'STATE\n', question: 'v', options: ['A1', 'B1'] });
		const without = RDT.renderTurn({ state: 'STATE', question: 'v', options: ['A1', 'B1'] });
		assert.notStrictEqual(withNl, without,
			'trimming the state would change the prompt by one byte, hence the cache key AND the numbers');
		assert.ok(/\n$/.test(FIX.rows[0].state),
			'the campaign state ends with a newline — that is the one the layout depends on');
	});

	test('THE OPTION ORDER IS THE DECLARED ONE (never permuted by the module)', () => {
		const a = RDT.renderTurn({ state: null, question: 'v', options: ['ZEBRA', 'ALPHA'] });
		assert.ok(/A\. ZEBRA\nB\. ALPHA$/.test(a),
			'the module RE-SORTED the menu: permutation costs 5.6 % of flips with 2 options and 17.7 % '
			+ 'on near-identical labels (measured 2026-09-20) — the order belongs to the caller');
	});

	test('NEGATIVE CONTROL — permuting the codomain permutes the letters: nothing canonises the order', () => {
		const a = RDT.renderTurn({ state: null, question: 'v', options: ['ALPHA', 'ZEBRA'] });
		const b = RDT.renderTurn({ state: null, question: 'v', options: ['ZEBRA', 'ALPHA'] });
		assert.notStrictEqual(a, b,
			'two codomains in different orders render the SAME prompt — the module sorts behind our back');
	});

	test('the body carries `logprobs`, `top_logprobs`, `max_tokens: 1` and thinking OFF', () => {
		const p = RDT.chatParams({ content: 'X' });
		assert.strictEqual(p.logprobs, true, 'without `logprobs` the server returns NO distribution at all');
		assert.strictEqual(p.top_logprobs, 20);
		assert.strictEqual(p.max_tokens, 1);
		assert.strictEqual(p.temperature, 0);
		assert.deepStrictEqual(p.chat_template_kwargs, { enable_thinking: false },
			'without cutting thinking, the first generated token is `<think>`, not the answer');
		assert.strictEqual(p.seed, undefined, 'nothing is sampled: a seed would suggest a draw');
		assert.strictEqual(p.model, undefined, 'no model unless the caller names one');
	});
});

describe('readout — the distribution', () => {

	test('THE PROBABILITIES SUM TO 1 OVER THE OPTIONS, and `coverage` says what was dropped', () => {
		const e = RDT.entriesOf(chat([['A', Math.log(0.6)], ['B', Math.log(0.2)], ['The', Math.log(0.2)]]));
		const d = RDT.distribution(e, ['A', 'B']);
		const sum = d.probabilities.reduce(( a, b ) => a + b, 0 );
		assert.ok(Math.abs(sum - 1) < 1e-9,
			'THE DISTRIBUTION DOES NOT SUM TO 1 OVER THE OPTIONS (' + sum + ') — the margin read would be '
			+ 'that of a truncated distribution, hence underestimated, hence more abstentionist than measured');
		assert.ok(Math.abs(d.coverage - 0.8) < 1e-9, '`coverage` must count the option mass');
		assert.ok(Math.abs(d.probabilities[0] - 0.75) < 1e-9, '0.6/0.8 = 0.75 after renormalisation');
		assert.strictEqual(d.degraded, false);
	});

	test('NEGATIVE CONTROL — the RAW mass does NOT sum to 1: the renormalisation is what buys the invariant', () => {
		const e = RDT.entriesOf(chat([['A', Math.log(0.6)], ['B', Math.log(0.2)], ['The', Math.log(0.2)]]));
		const d = RDT.distribution(e, ['A', 'B']);
		const raw = d.mass.reduce(( a, b ) => a + b, 0 );
		assert.ok(Math.abs(raw - 1) > 0.1,
			'the raw mass already sums to 1 — this case carries no mass outside the options, so it cannot '
			+ 'prove the renormalisation');
	});

	test('the SPACE-VARIANT rule is applied AND counted separately ("A" and " A")', () => {
		const e = RDT.entriesOf(chat([['A', Math.log(0.5)], [' A', Math.log(0.3)], ['B', Math.log(0.2)]]));
		const d = RDT.distribution(e, ['A', 'B']);
		assert.ok(Math.abs(d.mass[0] - 0.8) < 1e-9, '"A" and " A" are THE SAME answer');
		assert.ok(Math.abs(d.exactMass - 0.7) < 1e-9, 'exact = A(0.5) + B(0.2)');
		assert.ok(Math.abs(d.spacedMass - 0.3) < 1e-9, 'spaced = " A"(0.3) — returned apart, hence auditable');
	});

	test('CASE is not tolerated — "a" is not "A"', () => {
		const e = RDT.entriesOf(chat([['a', Math.log(0.9)], ['B', Math.log(0.1)]]));
		const d = RDT.distribution(e, ['A', 'B']);
		assert.ok(Math.abs(d.mass[0]) < 1e-12, '"a" counted for A: that would be another answer');
	});

	test('NEGATIVE CONTROL — A TOKEN OUTSIDE THE OPTIONS IS NOT A VERDICT: coverage 0 => `degraded`, '
		+ 'uniform, and NEVER a choice under theta > 0', () => {
		const e = RDT.entriesOf(chat([['The', Math.log(0.7)], ['Both', Math.log(0.3)]]));
		const d = RDT.distribution(e, ['A', 'B']);
		assert.strictEqual(d.degraded, true,
			'NO option mass and yet `degraded: false` — a silent uniform reads as hesitation when the model '
			+ 'actually answered something else');
		assert.strictEqual(d.coverage, 0);
		const v = RDT.decide({ probabilities: d.probabilities, options: ['SAME', 'OTHER'], theta: 0.5 });
		assert.ok(v.undecided === true && v.choice === null,
			'A TOKEN OUTSIDE THE OPTIONS PRODUCED A VERDICT (choice=' + JSON.stringify(v.choice)
			+ ', coverage=' + d.coverage + ') — an empty distribution turned uniform and then cut is the '
			+ 'worst false positive available');
	});

	test('both response shapes are read: `/v1/chat/completions` and `/v1/completions`', () => {
		const pairs = [['A', Math.log(0.6)], ['B', Math.log(0.4)]];
		const a = RDT.distribution(RDT.entriesOf(chat(pairs)), ['A', 'B']);
		const b = RDT.distribution(RDT.entriesOf(compl(pairs)), ['A', 'B']);
		assert.deepStrictEqual(a.probabilities, b.probabilities,
			'the two paths must return the SAME distribution — otherwise a replay and a live call measure '
			+ 'two different things');
	});

	test('NEGATIVE CONTROL — a response WITHOUT logprobs returns an empty list, not an invented distribution', () => {
		assert.deepStrictEqual(RDT.entriesOf({ choices: [{ message: { content: 'B' } }] }), [],
			'candidates were fabricated from a response that carried none');
		assert.deepStrictEqual(RDT.entriesOf(null), []);
	});
});

describe('readout — the margin, the bands, the codomain', () => {

	test('A MARGIN UNDER theta RETURNS UNDECIDED, NEVER A VERDICT', () => {
		const v = RDT.decide({ probabilities: [0.6, 0.4], options: ['SAME', 'OTHER'], theta: 0.5 });
		assert.strictEqual(v.margin.toFixed(6), '0.200000');
		assert.ok(v.undecided === true && v.choice === null,
			'A MARGIN UNDER theta RETURNED A VERDICT (margin=' + v.margin + ' < theta=' + v.theta
			+ ', choice=' + JSON.stringify(v.choice) + ') — at theta = 0 the measurement gives 100 % of new '
			+ 'entities wrongly merged, which is exactly what the margin removes');
		assert.strictEqual(v.top, 'SAME', 'the `top` stays readable: it is what a review queue shows');
	});

	test('NEGATIVE CONTROL — the SAME distribution at theta = 0 returns a verdict: theta is what buys '
		+ 'the abstention', () => {
		const v = RDT.decide({ probabilities: [0.6, 0.4], options: ['SAME', 'OTHER'], theta: 0 });
		assert.strictEqual(v.undecided, false);
		assert.strictEqual(v.choice, 'SAME',
			'at theta = 0 no verdict is returned — then the abstention comes from somewhere other than theta');
	});

	test('the BANDS follow the edges 0.5 / 0.75 / 0.9, and the prior is the MIDDLE of the band', () => {
		assert.strictEqual(RDT.bandOf(0.40), 'low');
		assert.strictEqual(RDT.bandOf(0.50), 'med');
		assert.strictEqual(RDT.bandOf(0.74), 'med');
		assert.strictEqual(RDT.bandOf(0.75), 'high');
		assert.strictEqual(RDT.bandOf(0.90), 'certain');
		assert.strictEqual(RDT.snap(0.9137), 0.95,
			'the raw float is not portable between engines (2.3-10.4 % of verdicts change) — the band is '
			+ '(0-0.1 % above 0.9)');
		assert.strictEqual(RDT.snap(0.62), 0.625);
	});

	test('the codomain `choice` keeps the CODES, `noul` returns a boolean, `score` an integer — no '
		+ 'language enters', () => {
		const c = RDT.codomain({ choice: ['SAME', 'OTHER'] });
		assert.deepStrictEqual(c.options, ['SAME', 'OTHER']);
		const n = RDT.codomain({ noul: true });
		assert.deepStrictEqual(n.options, ['true', 'false'], 'boolean literals, not words of a language');
		assert.strictEqual(n.decode('true'), true);
		const s = RDT.codomain({ score: 5 });
		assert.deepStrictEqual(s.options, ['1', '2', '3', '4', '5']);
		assert.strictEqual(s.decode('4'), 4);
	});

	test('NEGATIVE CONTROL — a codomain with one option, a duplicate, or 27 options is REFUSED and NAMED', () => {
		assert.throws(() => RDT.codomain({ choice: ['ALONE'] }), /at least 2 options/);
		assert.throws(() => RDT.codomain({ choice: ['X', 'X'] }), /DOUBLE/,
			'two letters for the same answer split its mass: the margin would be wrong, downwards');
		const many = []; for ( let i = 0; i < 27; i++ ) many.push('C' + i);
		assert.throws(() => RDT.codomain({ choice: many }), /letter regime/);
		assert.throws(() => RDT.codomain({}), /no question form/);
	});

	test('NO "UNDECIDED" option is ever offered to the model — the abstention comes from the margin', () => {
		const c = RDT.codomain({ choice: ['SAME', 'OTHER'] });
		assert.ok(c.options.indexOf(RDT.UNDECIDED) < 0,
			'an offered door gets taken: abstention is a READING of the distribution, never a menu entry');
		const menu = RDT.renderTurn({ state: null, question: 'verdict', options: c.options });
		assert.ok(menu.indexOf(RDT.UNDECIDED) < 0, 'the rendered menu must carry no escape hatch');
	});

	test('NEGATIVE CONTROL — a distribution whose size does not follow the codomain is REFUSED', () => {
		assert.throws(() => RDT.decide({ probabilities: [0.5, 0.3, 0.2], options: ['A', 'B'] }),
			/diverged/, 'a margin read on a misaligned menu would be a number about nothing');
	});
});

describe('readout — the recorded RAW, and what a log can be read back for', () => {

	test('the RAW of a readout is the DISTRIBUTION, not the letter — and it round-trips', () => {
		const resp = chat([['A', -0.3889], ['B', -1.1389]]);
		const s = RDT.rawOf(resp);
		assert.ok(/"readout"/.test(s), 'the log must carry the distribution: a log that says "B" cannot be '
			+ 'replayed, recalibrated, or turned back into a margin');
		const back = RDT.parseRaw(s);
		assert.strictEqual(back.length, 2);
		assert.strictEqual(back[0].token, 'A');
		assert.ok(Math.abs(back[0].prob - Math.exp(-0.3889)) < 1e-9);
	});

	test('NEGATIVE CONTROL — `rawOf` on a response without distribution is `null`, and `logRawFor` on an '
		+ 'ordinary (non-logprobs) call TOUCHES NOTHING', () => {
		assert.strictEqual(RDT.rawOf({ choices: [{ message: { content: 'B' } }] }), null,
			'a RAW was fabricated for a response that carried no distribution');
		assert.strictEqual(RDT.logRawFor({ logprobs: false }, chat([['A', -1]])), null,
			'a generative call got its log rewritten — an ordinary call must come out identical');
		assert.ok(RDT.logRawFor(RDT.chatParams({ content: 'x' }), chat([['A', -1]])),
			'a readout call did NOT get its distribution logged — then the log is one letter, and useless');
	});

	test('the question name and the menu are read back FROM the prompt, never assumed', () => {
		const p = RDT.renderTurn({ state: 'x\n', question: 'englobe(A|B|EQUAL)', options: ['A', 'B', 'EQUAL'] });
		assert.strictEqual(RDT.questionTagOf(p), 'englobe(A|B|EQUAL)',
			'two different questions asked on the SAME state share every block but this line: an instrument '
			+ 'that keys repeats on the state alone reports "unstable verdict" on two distinct questions');
		assert.deepStrictEqual(RDT.menuOf(p), ['A', 'B', 'EQUAL']);
		assert.strictEqual(RDT.questionTagOf('some free generation prompt'), null);
	});
});
