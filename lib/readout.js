'use strict';
/**
 * @file lib/readout.js — READ the decision out of the distribution, instead of making it write one.
 *
 * PURE module: no network, no model, no state. It builds the exact string that goes to the server,
 * and it reads the distribution that comes back. I/O is injected by the caller (`lib/client.js`
 * does the HTTP, nothing else does). That separation is what makes a measurement reproducible:
 * a recorded response can be replayed through this file with no GPU at all.
 *
 * ── WHAT THIS IS, AND WHERE THE NUMBERS COME FROM ──────────────────────────────────────────
 * A judge with a CLOSED codomain does not need to GENERATE its verdict: the server already
 * exposes the next-token distribution (`logprobs`). Restrict it to the option tokens, renormalise,
 * and you get a verdict PLUS a probability. Measured in the wiseways.me project on 2026-09-20
 * (n = 1224 judge questions, null arm "always the majority class" 0.693): **0.947 agreement with
 * the generating (grammar-constrained) arm** on vLLM (0.935 on GGUF), raw ECE 0.090,
 * **70 ms/question** on vLLM against 290 ms on GGUF, 6.5 % flips when A and B are swapped.
 *
 * ── THE PRODUCT IS NOT THE VERDICT, IT IS THE MARGIN ───────────────────────────────────────
 * `margin = p1 - p2` on the renormalised distribution; the verdict is only returned when
 * `margin >= theta`, otherwise UNDECIDED — and an UNDECIDED must write NOTHING (no merge, no
 * opposite memory): the question stays PENDING and is asked again when the state changes.
 * Measured on the entity-anchoring bench: theta = 0 => 100 % of NEW entities wrongly merged;
 * theta = 0.5 => 93 % precision and 72 % correct abstention. theta is therefore SWEPT, never
 * fixed by a comment: the output of a campaign is the coverage x precision curve (`lib/metrics.js`),
 * and the in-flight value is read off that curve.
 *
 * ── THE BAND, AND WHY IT IS PORTABLE WHEN THE POINT IS NOT ─────────────────────────────────
 * Between two engines serving the SAME model (GGUF vs vLLM), 2.3 % to 10.4 % of verdicts differ —
 * but **0 to 0.1 % among those at p >= 0.90**. The disagreement zone is exactly the one the margin
 * removes. So `p1` is placed in a BAND (edges 0.5 / 0.75 / 0.9) and the raw float is never stored
 * as if it were a measurement: the prior returned is the MIDDLE of the band (`snap`).
 *
 * ── THE LETTER REGIME, AND WHY NOT THE CODES ───────────────────────────────────────────────
 * Options are presented as `A.`, `B.`, ... and the mass of the `A`/`B` tokens is read. The
 * "direct code" regime (reading the mass of `MEME`/`AUTRE`) is REFUSED as soon as two codes share
 * their first token — measured: 17 IPTC codes all start with `medtop:`, and only 18 distinct first
 * tokens for 19 action roots. A letter is one token, always (verify it on YOUR tokenizer).
 *
 * ── THE SPACE-VARIANT RULE, DECLARED (and counted) ─────────────────────────────────────────
 * A token counts for option `A` when its TRIMMED text equals `A`: `"A"` and `" A"` are the same
 * answer. Both masses are returned SEPARATELY (`exactMass` / `spacedMass`) so that the choice is
 * auditable rather than assumed — measured at <= 0.08 % of coverage on the bench, ON A FAMILY
 * WHERE BOTH SURFACE FORMS ARE TOKENS (Ġ-BPE): on SentencePiece vocabs `" A"` IS `"A"` (one ID
 * token per option) and `spacedMass` is a structural zero; on Phi-3-style vocabs `" A"` is
 * multi-token and unreadable at `max_tokens: 1`. `tokenizer.checkSpacedLetters` inventories the
 * regime — against the deployed server, whose detokenised piece picks the bucket.
 * Case, on the other hand, is NOT tolerated (`a` != `A`): that would be another answer.
 *
 * ── `coverage`: THE MASS THAT IS NOT IN THE OPTIONS ────────────────────────────────────────
 * `coverage` = sum of the option masses. A readout with low coverage is a readout where the model
 * meant to say something else — on long menus of near-identical labels, 0.92-0.95 was measured.
 * It is ALWAYS returned, and `degraded` says when the distribution carried nothing: returning the
 * uniform silently would make "the model said something else" look like "the model hesitates".
 *
 * CommonJS on purpose: `require`-able as-is, no build step, no runtime dependency.
 */

/** The labels of the letter regime. One token per letter on every tokenizer used here. */
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** The ceiling of a `choice` — 26 letters, and the boundary of the contract. */
const MAX_OPTIONS = LETTERS.length;

/**
 * THE READOUT ENVELOPE — the only fixed string in this module, and it is MEASURED.
 *
 * This is the FORMAT instruction of the harness, the one under which the 2026-09-20 numbers were
 * obtained, and "the prompt weighs more than the engine" (same engine, 0.833 vs 0.733 on layout
 * alone): changing it invalidates the comparison. It is therefore frozen here, and overridable
 * through `opts.instruction` so that a variation gets MEASURED instead of decreed — one at a time,
 * with the prompt printed. The QUESTION never lives here: it comes from the caller.
 *
 * It carries no decision about MEANING: no word list of any language decides anything in this
 * library. Options, their descriptions and the question text are the caller's, always.
 */
const INSTRUCTION = 'Choose the correct option. Reply with only its letter.';
/** The keyword of the question line. Structural: it introduces the NAME of the field, not a sense. */
const QUESTION_TAG = 'Question: ';
/** The keyword of the state block. Same status as `QUESTION_TAG`. */
const CONTEXT_TAG = 'Context:';

/** The band edges. `p1 < 0.5` is impossible with 2 options but legitimate beyond: the `low` band
 *  exists for long menus. */
const BAND_EDGES = [0.5, 0.75, 0.9];
/** The band names — CODES, not labels: no UI shows them as-is. */
const BANDS = ['low', 'med', 'high', 'certain'];
/** The default theta when no calibration carries one. Read off the 2026-09-20 curve (anchoring:
 *  theta = 0.5 => precision 0.927, correct abstention 0.716). It is meant to be REPLACED by a
 *  measured value, not discussed in a comment. */
const THETA_DEFAULT = 0.5;

/** The verdict returned when the margin is under theta. It is NOT an option of the codomain: it is
 *  never offered to the model (an offered door gets taken — measured: a "cannot tell" option
 *  offered in readout is taken 1/1000, and it is the margin that is tunable, not it). */
const UNDECIDED = 'UNDECIDED';

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * (1) THE CODOMAIN — what the caller asks for, turned into RENDERED options, without permutation
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The RENDERED options of a typed question, plus what is needed to re-type the answer.
 *
 * Three forms, all reduced to a `choice` — the only object the letter regime can read, and what
 * guarantees that one more question costs the same mechanism:
 *   - `{ choice: [codes] }` — the CODES of the codomain, IN THEIR DECLARED ORDER;
 *   - `{ noul: true }`      — a boolean. The rendered options are the literals `true`/`false`:
 *                             no natural language enters through this door;
 *   - `{ score: n }`        — a `1..n` scale. The options are the DIGITS.
 *
 * THE ORDER IS THE DECLARED ONE. Nothing here sorts, deduplicates by similarity, or permutes:
 * permuting the menu costs **5.6 % of flips with 2 options and 17.7 % on near-identical labels**
 * (measured 2026-09-20). A caller who wants another presentation changes THEIR codomain, and says so.
 *
 * @returns `{ options, kind, decode(code) }`
 */
function codomain( opts ) {
	const o = opts || {};
	if ( Array.isArray(o.choice) ) {
		const options = o.choice.map(( x ) => String(x) );
		assertOptions(options, 'choice');
		return { options: options, kind: 'choice', decode: ( c ) => c };
	}
	if ( o.noul === true ) {
		const options = ['true', 'false'];
		return { options: options, kind: 'noul', decode: ( c ) => c === 'true' };
	}
	if ( o.score !== undefined ) {
		const n = Number(o.score);
		if ( !Number.isInteger(n) || n < 2 )
			throw new Error('readout.codomain: `score` expects an integer >= 2, got ' + JSON.stringify(o.score)
				+ '. A scale with a single grade is not a question.');
		const options = [];
		for ( let i = 1; i <= n; i++ ) options.push(String(i));
		assertOptions(options, 'score');
		return { options: options, kind: 'score', decode: ( c ) => parseInt(c, 10) };
	}
	throw new Error('readout.codomain: no question form. Pass `choice: [codes]`, `noul: true` or '
		+ '`score: n`. Without a closed codomain there is no readout — there is free generation, '
		+ 'and that is another call.');
}

/** The refusals a codomain must go through BEFORE leaving: every one of them is a measured failure. */
function assertOptions( options, kind ) {
	if ( !Array.isArray(options) || options.length < 2 )
		throw new Error('readout: a `' + kind + '` needs at least 2 options, got '
			+ (options ? options.length : 'none') + '. A question with one answer is not a question.');
	if ( options.length > MAX_OPTIONS )
		throw new Error('readout: ' + options.length + ' options — the letter regime carries at most '
			+ MAX_OPTIONS + ' (one letter = one token). Beyond that, split the question.');
	const seen = {};
	for ( const x of options ) {
		if ( !String(x).length )
			throw new Error('readout: an EMPTY option — the menu would carry a letter with no answer.');
		if ( seen[x] )
			throw new Error('readout: DOUBLE option "' + x + '". Two letters for one answer split its '
				+ 'mass over two tokens: the measured margin would be wrong, downwards.');
		seen[x] = 1;
	}
}

/** The reading labels (the letters), in the order of the options. */
function lettersOf( options ) {
	return options.map(( _, i ) => LETTERS[i] );
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * (2) THE EXACT STRING — written ONCE, shared by the live path and by the replay harness
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * THE USER TURN, word for word.
 *
 * The layout is the one under which the 2026-09-20 numbers were obtained, verified byte for byte
 * against the jobs of that campaign: instruction, blank line, `Context:`, the state, blank line,
 * `Question: <name>`, then one `X. option` per line. The state is NOT trimmed: in the measured
 * campaign the state template ends with a newline, and that newline is what produces the blank
 * line before `Question:` in the measured prompt. Trimming it would change one byte, hence the
 * cache key AND the numbers.
 *
 * @param o `{ state, question, options, instruction? }`
 */
function renderTurn( o ) {
	const options = (o && o.options) || [];
	assertOptions(options, 'choice');
	const lines = [(o && o.instruction) || INSTRUCTION];
	if ( o && o.state !== undefined && o.state !== null ) lines.push('', CONTEXT_TAG, String(o.state));
	lines.push('', QUESTION_TAG + String((o && o.question) || ''));
	for ( let i = 0; i < options.length; i++ ) lines.push(LETTERS[i] + '. ' + options[i]);
	return lines.join('\n');
}

/**
 * THE REQUEST BODY — a single constructor (lesson paid in the source project: two writers diverge
 * at the first tweak, and that is what sent 42 calls out with an empty constraint).
 *
 * `max_tokens` is 1: under readout only the first token is READ. Raising it to 2 does not change
 * the reading, it costs a token — it stays tunable because some chat templates emit an opening
 * newline, and that is better measured than assumed.
 *
 * `temperature: 0` has NO effect on the logprobs (nothing is sampled), but it keeps the cache key
 * aligned with a deterministic call. `seed` is not set: nothing is drawn.
 *
 * `chat_template_kwargs: { enable_thinking: false }` is what a thinking model needs so that the
 * first generated token is the answer and not `<think>`. Servers that do not know the field
 * (OpenAI) must have it removed — `lib/client.js` does that on request (`templateKwargs: null`).
 *
 * @param o `{ model?, content, maxTokens?, topLogprobs? }`
 */
function chatParams( o ) {
	const c = o || {};
	const params = {
		messages            : [{ role: 'user', content: String(c.content || '') }],
		temperature         : 0,
		max_tokens          : c.maxTokens === undefined ? 1 : c.maxTokens,
		logprobs            : true,
		top_logprobs        : c.topLogprobs === undefined ? 20 : c.topLogprobs,
		chat_template_kwargs: { enable_thinking: false },
	};
	if ( c.model ) params.model = c.model;
	return params;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * (3) THE READING — the distribution, then the decision
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * THE FIRST-TOKEN CANDIDATES, whatever the shape of the server response.
 *
 * Two shapes exist and BOTH must be read, otherwise a change of path would return an empty list —
 * that is, the uniform — WITHOUT RAISING ANYTHING:
 *   - `/v1/chat/completions` -> `choices[0].logprobs.content[0].top_logprobs = [{token, logprob}]`
 *   - `/v1/completions`      -> `choices[0].logprobs.top_logprobs[0] = { token: logprob }`
 *
 * @returns `[{ token, logprob, prob }]` — never `null`: an absence returns `[]`, and `distribution`
 *          NAMES it as `degraded`.
 */
function entriesOf( resp ) {
	const ch = resp && resp.choices && resp.choices[0];
	const lp = ch && ch.logprobs;
	if ( !lp ) return [];
	// chat shape: `content[0].top_logprobs`
	const first = Array.isArray(lp.content) ? lp.content[0] : null;
	if ( first && Array.isArray(first.top_logprobs) )
		return first.top_logprobs.map(( e ) => mkEntry(e.token, e.logprob) );
	// completions shape: `top_logprobs[0]` is an OBJECT { token: logprob }
	const tl = Array.isArray(lp.top_logprobs) ? lp.top_logprobs[0] : null;
	if ( tl && typeof tl === 'object' )
		return Object.keys(tl).map(( k ) => mkEntry(k, tl[k]) );
	return [];
}

function mkEntry( token, logprob ) {
	return { token: String(token), logprob: logprob, prob: Math.exp(Number(logprob)) };
}

/**
 * THE DISTRIBUTION OVER THE OPTIONS — restricted, then RENORMALISED.
 *
 * The matching rule is declared (see the header): TRIMMED text equal to the letter, case respected.
 * Both masses are returned separately.
 *
 * THE LETTER PRIOR, OPTIONAL (`letterPrior`) — the debiasing layer of Zheng et al. (ICLR 2024,
 * arXiv:2309.03882, PriDe): the model puts mass on LETTER TOKENS a priori (5.6 % of flips at 2
 * options, 36.7 % at 19), and that prior is divided out here, on the mass, per letter. Two rules
 * hold by construction:
 *   - `coverage` stays on the RAW mass: it means "the model wanted to answer something else", and
 *     a per-letter division would change what it means — the correction re-weights the options
 *     against each other, never the options against the rest of the vocabulary;
 *   - a DEGRADED distribution stays the uniform with `degraded: true`: an empty distribution does
 *     not get corrected, it abstains.
 * The prior is estimated per (model, tokenizer, menu size) by `harness.letterPrior` — carried
 * across any of those, it is a TRANSFER, published with its split like a fitted T, never silent.
 *
 * @returns `{ probabilities, mass, coverage, exactMass, spacedMass, degraded, letterPrior }` —
 *          `probabilities` SUMS TO 1 over the options (that is the invariant of the readout);
 *          `degraded: true` when NO option mass was seen: the uniform is then returned, and SAID —
 *          a silent uniform would read as hesitation; `letterPrior` is the prior APPLIED (or null).
 */
function distribution( entries, letters, letterPrior ) {
	const n = letters.length;
	const exact = new Array(n).fill(0), spaced = new Array(n).fill(0);
	for ( const e of (entries || []) ) {
		const raw = String(e && e.token);
		const i = letters.indexOf(raw.trim());
		if ( i < 0 ) continue;
		const p = (e.prob !== undefined && e.prob !== null) ? Number(e.prob) : Math.exp(Number(e.logprob));
		if ( !isFinite(p) ) continue;
		if ( raw === letters[i] ) exact[i] += p; else spaced[i] += p;
	}
	const mass = exact.map(( x, i ) => x + spaced[i] );
	const coverage = mass.reduce(( a, b ) => a + b, 0 );
	const degraded = !(coverage > 0);
	const uniform = mass.map(() => 1 / n );
	let probabilities, applied = null;
	if ( letterPrior !== undefined && letterPrior !== null ) {
		if ( !Array.isArray(letterPrior) || letterPrior.length !== n )
			throw new Error('readout.distribution: ' + (Array.isArray(letterPrior) ? letterPrior.length : 'not an array')
				+ ' prior entr(y|ies) for ' + n + ' option(s) — the prior over LETTERS is indexed by the menu it was '
				+ 'estimated on (harness.letterPrior), and a mismatched one divides the wrong letters.');
		const w = new Array(n);
		for ( let i = 0; i < n; i++ ) {
			w[i] = Number(letterPrior[i]);
			if ( !(w[i] > 0) )
				throw new Error('readout.distribution: letterPrior[' + i + '] is ' + JSON.stringify(letterPrior[i])
					+ ' — dividing by a zero prior would move an option to infinity, and the correction would '
					+ 'decide instead of the model.');
			w[i] = mass[i] / w[i];
		}
		const sum = w.reduce(( a, b ) => a + b, 0 );
		probabilities = !(sum > 0) ? uniform : w.map(( x ) => x / sum );
		applied = letterPrior.map(Number);
	} else {
		probabilities = degraded ? uniform : mass.map(( x ) => x / coverage );
	}
	return {
		probabilities: probabilities,
		mass         : mass,
		coverage     : coverage,
		exactMass    : exact.reduce(( a, b ) => a + b, 0 ),
		spacedMass   : spaced.reduce(( a, b ) => a + b, 0 ),
		degraded     : degraded,
		letterPrior  : applied,
	};
}

/** THE BAND of `p` — `low` < 0.5 <= `med` < 0.75 <= `high` < 0.9 <= `certain`. */
function bandOf( p, edges ) {
	const e = edges || BAND_EDGES;
	const x = Number(p);
	for ( let i = e.length - 1; i >= 0; i-- ) if ( x >= e[i] ) return BANDS[i + 1];
	return BANDS[0];
}

/**
 * THE PRIOR OF A BAND — its MIDDLE, never the raw float.
 *
 * The point is not portable between engines (2.3-10.4 % of verdicts change), the band is
 * (0-0.1 % above 0.9). Storing `0.9137` would promise a precision the measurement does not carry.
 */
function snap( p, edges ) {
	const e = edges || BAND_EDGES;
	const bounds = [0].concat(e).concat([1]);
	const x = Number(p);
	for ( let i = bounds.length - 2; i >= 0; i-- )
		if ( x >= bounds[i] ) return (bounds[i] + bounds[i + 1]) / 2;
	return (bounds[0] + bounds[1]) / 2;
}

/**
 * THE VERDICT, OR THE ABSTENTION — `top1` if `margin >= theta`, otherwise UNDECIDED.
 *
 * `undecided` is NOT a fallback verdict: it is the ABSENCE of a verdict. A caller who treats it as
 * "the other option" re-introduces exactly what the margin removes (measured: at theta = 0, 100 %
 * of new entities get wrongly merged).
 *
 * @param o `{ probabilities, options, theta?, edges? }`
 * @returns `{ choice, index, top, p1, p2, margin, band, prior, undecided, theta }`
 */
function decide( o ) {
	const probs = (o && o.probabilities) || [];
	const options = (o && o.options) || [];
	if ( probs.length !== options.length )
		throw new Error('readout.decide: ' + probs.length + ' probabilit(y|ies) for ' + options.length
			+ ' option(s) — the distribution and the codomain have diverged, no margin is readable.');
	const theta = (o && o.theta !== undefined && o.theta !== null) ? Number(o.theta) : THETA_DEFAULT;
	let i1 = 0;
	for ( let i = 1; i < probs.length; i++ ) if ( probs[i] > probs[i1] ) i1 = i;
	let p2 = 0;
	for ( let i = 0; i < probs.length; i++ ) if ( i !== i1 && probs[i] > p2 ) p2 = probs[i];
	const p1 = probs[i1];
	const margin = p1 - p2;
	const undecided = !(margin >= theta);
	return {
		choice   : undecided ? null : options[i1],
		index    : undecided ? -1 : i1,
		top      : options[i1],
		p1       : p1,
		p2       : p2,
		margin   : margin,
		band     : bandOf(p1, o && o.edges),
		prior    : snap(p1, o && o.edges),
		undecided: undecided,
		theta    : theta,
	};
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * (4) THE RECORDED RAW — one writer, one reader
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * THE DISTRIBUTION, IN THE FORM THAT GOES INTO A LOG.
 *
 * A logger usually records the generated text, and under readout that text is ONE LETTER. A log
 * that says "B" allows neither replaying a decision, nor measuring a calibration, nor rebuilding a
 * margin: the RAW of a readout IS the distribution. Written by `rawOf`, read back by `parseRaw` —
 * one writer, one reader, here.
 *
 * The LETTERS are logged, not the codes: the menu (`A. MEME`) is in the prompt, which is logged
 * too, and `menuOf` rebuilds the correspondence without assuming it.
 *
 * @returns a compact JSON string, or `null` if the response carries no distribution.
 */
function rawOf( resp ) {
	const entries = entriesOf(resp);
	if ( !entries.length ) return null;
	return JSON.stringify({ readout: entries.map(( e ) => ({
		t : e.token,
		lp: Math.round(Number(e.logprob) * 10000) / 10000,
	}) ) });
}

/**
 * THE PROVIDER-WRAPPER DECISION, ISOLATED AND PURE.
 *
 * A wrapper that decides "when do we enrich the log with the distribution?" must be testable, so
 * the RULE lives here rather than inside the wrapper.
 *
 * @param prompt the request body as the caller passed it
 * @param resp   the server response
 * @returns the string to put in the log, or `null` — and `null` means TOUCH NOTHING: an ordinary
 *          call must come back out identical, by object identity.
 */
function logRawFor( prompt, resp ) {
	if ( !resp || !prompt || typeof prompt !== 'object' || prompt.logprobs !== true ) return null;
	return rawOf(resp);
}

/** The reading of `rawOf` — returns `[{token, logprob, prob}]`, or `[]` if it is not a readout. */
function parseRaw( s ) {
	if ( !s ) return [];
	let o = null;
	try { o = JSON.parse(String(s)); } catch ( e ) { return []; }
	if ( !o || !Array.isArray(o.readout) ) return [];
	return o.readout.map(( e ) => mkEntry(e.t, e.lp) );
}

/**
 * THE QUESTION NAME, read back from a logged prompt (`Question: <name>`).
 *
 * Why it must be READ (measured instrument artefact): when two different questions are asked on
 * the SAME state, their prompts share every block but the question line. An instrument that keys
 * repeats on the state alone merges them and reports "unstable verdict" on two questions that
 * simply are not the same question. The repeat key must carry the question, and it is written in
 * the prompt.
 *
 * @returns the name, or `null` on a generative prompt (it has no readout envelope).
 */
function questionTagOf( prompt ) {
	const m = new RegExp('^' + QUESTION_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(.+)$', 'm')
		.exec(String(prompt || ''));
	return m ? m[1].trim() : null;
}

/** The menu as `renderTurn` wrote it, read back from a logged prompt: `A. CODE` per line.
 *  That is what makes the letter -> code correspondence READABLE in a log, without assuming it. */
function menuOf( prompt ) {
	const out = [];
	const re = /^([A-Z])\. (.+)$/gm;
	let m;
	while ( (m = re.exec(String(prompt || ''))) ) {
		const i = LETTERS.indexOf(m[1]);
		if ( i === out.length ) out.push(m[2]);
	}
	return out;
}

module.exports = {
	LETTERS, MAX_OPTIONS, INSTRUCTION, QUESTION_TAG, CONTEXT_TAG,
	BAND_EDGES, BANDS, THETA_DEFAULT, UNDECIDED,
	codomain, assertOptions, lettersOf, renderTurn, chatParams,
	entriesOf, distribution, bandOf, snap, decide,
	rawOf, parseRaw, menuOf, questionTagOf, logRawFor,
};
