'use strict';
/**
 * @file lib/wire.js — THE JEV WIRE CONTRACT, TRANSLATED (never imitated silently).
 *
 * `POST /v1/systemone` — the one-endpoint contract of TypeSafe's Jev and of the OpenJev ecosystem:
 * `{ model?, state, questions: { name: { type, instructions, criteria } } }`, answers grouped by type
 * (`nouls`, `choices`, `scores`), errors as FastAPI-shaped `422` detail lists. A `typesafe-sdk`
 * pointed at `notjev serve` works unchanged; so does anything that speaks the contract.
 *
 * The translation is one to one, and every place where the readout is NARROWER than Jev refuses with
 * a named reason instead of degrading the request:
 *   - `choice` carries at most `readout.MAX_OPTIONS` (26) options — one letter = one token. Jev
 *     allows 255; a request with more is REFUSED (`422`), never silently truncated.
 *   - `score` is an expectation over 2..26 named levels, 0-indexed like Jev (`Σ i·pᵢ`).
 *   - `confidence` is `1 − H(p)/ln K` over the RENORMALISED distribution — 1 when certain,
 *     0 when uniform. It is a function of what was read, never a promise about the model.
 *
 * What this module does NOT do: decide. `theta` is a notjev EXTENSION (request-level, default `0` —
 * the wire contract has no abstention), and when it bites, the answer carries `choice: null` with the
 * reason in the `notjev` block, never a fallback. The `notjev` block on every answer exposes the
 * instrument — `margin`, `band`, `coverage`, `degraded` — the fields the wire contract has no room
 * for and the fields that make the numbers auditable.
 */

const { fail } = require('./errors');
const readout = require('./readout');
const { formOf } = require('./client');

const TYPES = ['noul', 'choice', 'score'];

/** A `422` with the FastAPI detail list attached — the shape Jev clients parse. */
function refuse( loc, msg, type ) {
	const e = fail('NOTJEV_WIRE_422', 'notjev: ' + msg, {
		detail: [{ type: type || 'value_error', loc: loc, msg: msg }],
	});
	e.status = 422;
	return e;
}

/* ── REQUEST: the wire questions -> the library's question forms ──────────────────────────── */

/**
 * @param body `{ model?, state, theta?, concurrency?, questions: { name: { type, instructions, criteria } } }`
 * @returns `{ state, theta, questions, specs }` — `questions` for `client.decideMany`, `specs` to
 *           rebuild the grouped answers (same order as `questions`).
 * @throws `NOTJEV_WIRE_422` with a `.detail` FastAPI list.
 */
function toQuestions( body ) {
	const b = body || {};
	if ( typeof b !== 'object' || Array.isArray(b) )
		throw refuse(['body'], 'the request body must be a JSON object.', 'type_error');
	if ( typeof b.state !== 'string' )
		throw refuse(['body', 'state'], '`state` is required and must be a string.', 'missing');
	if ( !b.questions || typeof b.questions !== 'object' || Array.isArray(b.questions) )
		throw refuse(['body', 'questions'], '`questions` is required and must be an object '
			+ 'of named, typed questions.', 'missing');
	const names = Object.keys(b.questions);
	if ( !names.length )
		throw refuse(['body', 'questions'], '`questions` is empty — one state, no question, no readout.');
	if ( b.model !== undefined && b.model !== null && typeof b.model !== 'string' )
		throw refuse(['body', 'model'], '`model`, when given, must be a string. The served engine '
			+ 'is the one the server is configured with; this field is accepted and reported back.');
	const theta = b.theta === undefined || b.theta === null ? 0 : Number(b.theta);
	if ( !Number.isFinite(theta) || theta < 0 || theta >= 1 )
		throw refuse(['body', 'theta'], '`theta`, when given, must be a number in [0, 1).');

	const questions = [];
	const specs = [];
	for ( const name of names ) {
		const q = b.questions[name];
		const loc = ['body', 'questions', name];
		if ( !q || typeof q !== 'object' || Array.isArray(q) )
			throw refuse(loc, 'a question must be an object `{ type, instructions, criteria }`.', 'type_error');
		if ( q.type === undefined || TYPES.indexOf(q.type) < 0 )
			throw refuse(loc.concat('type'), '`type` must be one of ' + TYPES.map(( t ) => JSON.stringify(t)).join(', ')
				+ ', got ' + JSON.stringify(q.type) + '.', 'enum');
		if ( typeof q.instructions !== 'string' || !q.instructions.trim().length )
			throw refuse(loc.concat('instructions'), '`instructions` is required — the question line '
				+ 'is the NAME of what is being asked.', 'missing');

		const cLoc = loc.concat('criteria');
		let form = null;
		if ( q.type === 'noul' ) {
			const c = q.criteria === undefined || q.criteria === null ? {} : q.criteria;
			if ( typeof c !== 'object' || Array.isArray(c) )
				throw refuse(cLoc, 'the `noul` criteria are optional `{ true: …, false: … }` '
					+ 'descriptions of the two options.', 'type_error');
			const yes = c.true !== undefined ? c.true : c.yes;
			const no = c.false !== undefined ? c.false : c.no;
			/* No criteria: the LITERALS `true`/`false` (not words of a language). With criteria: the
			 * ids stay `true`/`false` — the wire answer `noul` is P(true) — only the menu text grows. */
			form = yes === undefined && no === undefined ? { noul: true } : { noul: {
				yes: yes === undefined ? 'true' : { id: 'true', description: String(yes) },
				no : no === undefined ? 'false' : { id: 'false', description: String(no) } } };
		} else if ( q.type === 'choice' ) {
			const c = q.criteria;
			if ( !c || typeof c !== 'object' || Array.isArray(c) )
				throw refuse(cLoc, 'a `choice` needs `criteria: { name: description }` — the menu '
					+ 'is the caller\'s, always.', 'missing');
			const options = Object.keys(c).map(( id ) => c[id] === undefined || c[id] === null || c[id] === ''
				? id : { id: id, description: String(c[id]) });
			form = { options: options };
		} else {
			const c = q.criteria;
			if ( !Array.isArray(c) )
				throw refuse(cLoc, 'a `score` needs `criteria: [level0, level1, …]` — 2 to '
					+ readout.MAX_OPTIONS + ' NAMED levels, read as one distribution.', 'missing');
			form = { options: c.map(( x ) => x === undefined || x === null ? '' : String(x)) };
		}

		/* The library's own guards (letter regime, doubles, emptiness) are run HERE — a request the
		 * readout cannot honour is refused `422` BEFORE the engine is spent, never as an upstream
		 * failure three seconds later, and never by silently truncating the menu. */
		const question = Object.assign({ id: name, question: q.instructions }, form, { theta: theta });
		let ids = null;
		try {
			ids = formOf(question).ids;
		} catch ( e ) {
			throw refuse(loc, String((e && e.message) || e).replace(/^(?:readout|notjev): /, ''));
		}
		questions.push(question);
		specs.push({ name: name, type: q.type, criteria: q.criteria || null, ids: ids });
	}

	return { state: b.state, theta: theta, questions: questions, specs: specs };
}

/* ── RESPONSE: the decisions -> the grouped answers of the wire contract ───────────────────── */

/** `1 − H(p)/ln K` — certain = 1, uniform = 0. A function of the read distribution, nothing else. */
function confidenceOf( probabilities ) {
	const p = (probabilities || []).filter(( x ) => Number.isFinite(x) && x > 0);
	if ( !p.length ) return 0;
	let h = 0;
	for ( const x of p ) h -= x * Math.log(x);
	return h === 0 ? 1 : Math.max(0, 1 - h / Math.log(p.length));
}

/** The instrument fields the wire contract has no room for — the audit trail, on every answer. */
function extensionOf( r ) {
	return {
		p1      : r.p1, p2: r.p2, margin: r.margin, band: r.band, prior: r.prior,
		coverage: r.coverage, exactMass: r.exactMass, spacedMass: r.spacedMass,
		degraded: r.degraded, undecided: r.undecided, theta: r.theta, top: r.top,
	};
}

/**
 * @param specs the `specs` of `toQuestions` (same order as `results`)
 * @param results the `decideMany` rows
 * @returns `{ answers: { nouls, choices, scores }, usage: { input_tokens, output_tokens } }`
 * @throws `NOTJEV_WIRE_UPSTREAM` when any question failed — the wire contract has answers for every
 *         name or none at all; a half-filled response is a lie an SDK would not even notice.
 */
function toAnswers( specs, results ) {
	const answers = { nouls: {}, choices: {}, scores: {} };
	let inputTokens = 0, outputTokens = 0, seenUsage = false;
	for ( let i = 0; i < specs.length; i++ ) {
		const s = specs[i], r = results[i];
		if ( !r || r.error ) {
			const message = 'notjev: question ' + JSON.stringify(s.name) + ' failed — '
				+ String((r && r.error) || 'no result');
			throw fail('NOTJEV_WIRE_UPSTREAM', message, { detail: { error_type: 'upstream_error',
				message: message }, name: s.name });
		}
		const probabilities = {};
		s.ids.forEach(( id, j ) => { probabilities[id] = r.probabilities[j]; });
		const confidence = confidenceOf(r.probabilities);
		const ext = extensionOf(r);
		if ( s.type === 'noul' ) {
			answers.nouls[s.name] = { type: 'noul', noul: r.probabilities[0],
				confidence: confidence, notjev: ext };
		} else if ( s.type === 'choice' ) {
			answers.choices[s.name] = { type: 'choice', choice: r.choice,
				probabilities: probabilities, confidence: confidence, notjev: ext };
		} else {
			/* The expected level, 0-indexed like Jev — the whole distribution, not the top grade.
			 * DEGRADED reads have no expectation: no mass, no mean. `null` says so; `0` would not. */
			let score = null;
			if ( !r.degraded ) {
				score = 0;
				for ( let j = 0; j < r.probabilities.length; j++ ) score += j * r.probabilities[j];
			}
			answers.scores[s.name] = { type: 'score', score: score, legend: s.ids,
				probabilities: probabilities, confidence: confidence, notjev: ext };
		}
		const u = r.usage || {};
		const inTok = u.prompt_tokens !== undefined ? u.prompt_tokens : u.input_tokens;
		const outTok = u.completion_tokens !== undefined ? u.completion_tokens : u.output_tokens;
		if ( Number.isFinite(inTok) ) { inputTokens += inTok; seenUsage = true; }
		if ( Number.isFinite(outTok) ) { outputTokens += outTok; seenUsage = true; }
	}
	return { answers: answers, usage: { input_tokens: seenUsage ? inputTokens : null,
		output_tokens: seenUsage ? outputTokens : null } };
}

module.exports = { toQuestions, toAnswers, confidenceOf };
