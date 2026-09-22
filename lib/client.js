'use strict';
/**
 * @file lib/client.js — THE ONE PLACE THAT DOES I/O.
 *
 * `lib/readout.js` is pure: it builds the exact string and reads the distribution. This file adds
 * the only three things a server needs — an URL, a body, a retry — and nothing else. Keeping them
 * apart is what allows a recorded response to be replayed through the same reader with no GPU
 * (`readResponse`, used by `scripts/replay.js` and by `notjev replay`).
 *
 * NO LANGUAGE LIVES HERE. Options, their descriptions and the question text come from the caller,
 * always. `noul()` takes the two options as an argument for that reason: a library that hardcoded
 * a "yes"/"no" pair would hardcode a language, and would silently decide the meaning of an answer.
 * With no pair given, the literals `true`/`false` are used — they are not words of a language.
 */

const readout = require('./readout');

const DEFAULTS = {
	path        : '/v1/chat/completions',
	timeoutMs   : 60000,
	retries     : 2,
	retryDelayMs: 250,
	topLogprobs : 20,
	concurrency : 1,
};

/** An error that NAMES its cause — the caller must never have to guess from a stack. */
function fail( code, message, extra ) {
	const e = new Error(message);
	e.code = code;
	if ( extra ) Object.assign(e, extra);
	return e;
}

/* ── THE OPTIONS OF THE CALLER, NORMALISED ────────────────────────────────────────────────── */

/**
 * One option: a code (what comes back as `choice`) and the TEXT that is rendered in the menu.
 * `{ id, description }` renders `id: description`; `{ id, text }` renders `text` verbatim.
 *
 * A description CHANGES THE PROMPT, therefore the measurement: the published numbers were obtained
 * with bare codes. Adding descriptions is legitimate and often better — it is simply another
 * prompt, and it must be measured as one.
 */
function optionOf( x ) {
	if ( x === null || x === undefined )
		throw fail('NOTJEV_BAD_OPTION', 'notjev: an EMPTY option — the menu would carry a letter with no answer.');
	if ( typeof x === 'string' || typeof x === 'number' ) return { id: String(x), text: String(x) };
	if ( typeof x !== 'object' )
		throw fail('NOTJEV_BAD_OPTION', 'notjev: an option must be a code or `{ id, description? }`, got ' + typeof x);
	const id = String(x.id !== undefined ? x.id : x.code !== undefined ? x.code : x.value);
	if ( id === 'undefined' )
		throw fail('NOTJEV_BAD_OPTION', 'notjev: an option without `id` — the returned `choice` would have no code.');
	const text = x.text !== undefined ? String(x.text)
		: (x.description !== undefined && x.description !== null && String(x.description).length)
			? id + ': ' + String(x.description)
			: id;
	return { id: id, text: text };
}

/**
 * THE QUESTION FORM -> the codes, the rendered menu, and how to re-type the answer.
 * Three forms, exactly the three closed forms of the readout:
 *   `{ options: [...] }` · `{ noul: true | { yes, no } }` · `{ score: n | { min, max } }`
 */
function formOf( q ) {
	const o = q || {};
	if ( Array.isArray(o.options) ) {
		const xs = o.options.map(optionOf);
		const ids = xs.map(( x ) => x.id ), texts = xs.map(( x ) => x.text );
		readout.assertOptions(ids, 'choice');
		readout.assertOptions(texts, 'choice');
		return { kind: 'choice', ids: ids, texts: texts, decode: ( c ) => c, values: ids };
	}
	if ( o.noul !== undefined && o.noul !== null && o.noul !== false ) {
		if ( o.noul === true ) {
			const cod = readout.codomain({ noul: true });
			return { kind: 'noul', ids: cod.options, texts: cod.options, decode: cod.decode, values: [true, false] };
		}
		const y = optionOf(o.noul.yes !== undefined ? o.noul.yes : 'true');
		const n = optionOf(o.noul.no !== undefined ? o.noul.no : 'false');
		readout.assertOptions([y.id, n.id], 'noul');
		readout.assertOptions([y.text, n.text], 'noul');
		return {
			kind  : 'noul',
			ids   : [y.id, n.id],
			texts : [y.text, n.text],
			decode: ( c ) => c === y.id,
			values: [true, false],
		};
	}
	if ( o.score !== undefined && o.score !== null ) {
		const s = (typeof o.score === 'object') ? o.score : { min: 1, max: Number(o.score) };
		const min = s.min === undefined ? 1 : Number(s.min), max = Number(s.max);
		if ( !Number.isInteger(min) || !Number.isInteger(max) )
			throw fail('NOTJEV_BAD_SCORE', 'notjev: `score` expects whole grades, got { min: '
				+ JSON.stringify(s.min) + ', max: ' + JSON.stringify(s.max) + ' }. A scale read on one token '
				+ 'is a scale of DIGITS: for anything else, pass explicit `options`.');
		if ( max - min + 1 < 2 )
			throw fail('NOTJEV_BAD_SCORE', 'notjev: a scale with a single grade is not a question ('
				+ min + '..' + max + ').');
		const ids = [];
		for ( let i = min; i <= max; i++ ) ids.push(String(i));
		readout.assertOptions(ids, 'score');
		return { kind: 'score', ids: ids, texts: ids, decode: ( c ) => parseInt(c, 10),
			values: ids.map(( x ) => parseInt(x, 10) ) };
	}
	throw fail('NOTJEV_NO_FORM', 'notjev: no question form. Pass `options: [...]`, `noul: true` or '
		+ '`score: n`. Without a closed codomain there is no readout — there is free generation, and '
		+ 'this library does not do that.');
}

/* ── THE READING OF A RESPONSE (pure — replay lives on it) ────────────────────────────────── */

/**
 * READ A SERVER RESPONSE against a question form. Pure: no network, no clock.
 * This is the function a replay uses, so that a recorded run and a live run are READ BY THE SAME CODE.
 *
 * @param resp the parsed server response (chat or completions shape)
 * @param spec `{ options|noul|score, theta?, edges?, prompt?, request?, ms?, model? }`
 */
function readResponse( resp, spec ) {
	const s = spec || {};
	const form = s.form || formOf(s);
	const theta = s.theta === undefined || s.theta === null ? readout.THETA_DEFAULT : Number(s.theta);
	const letters = readout.lettersOf(form.ids);
	const entries = readout.entriesOf(resp);
	const dist = readout.distribution(entries, letters);
	const v = readout.decide({ probabilities: dist.probabilities, options: form.ids, theta: theta, edges: s.edges });
	/* A DEGRADED READOUT IS NEVER A VERDICT — client-side policy, on top of the pure margin rule.
	 * `readout.decide` only knows the margin, and on an empty distribution the uniform has margin 0:
	 * at theta = 0 it would therefore return the FIRST option, with full confidence in nothing. The
	 * model answered outside the codomain; that is not a tie, and it is the worst false positive
	 * available. `top` stays readable, the verdict does not exist. */
	const undecided = v.undecided || dist.degraded;
	const byOption = {};
	form.ids.forEach(( c, i ) => { byOption[c] = dist.probabilities[i]; });
	const out = {
		/** `false` when the distribution carried NO option mass: the model answered something else. */
		ok           : !dist.degraded,
		choice       : undecided ? null : v.choice,
		index        : undecided ? -1 : v.index,
		/** What the model would have said without the margin — readable, never applied. */
		top          : v.top,
		value        : undecided ? null : form.decode(v.top),
		p1           : v.p1,
		p2           : v.p2,
		margin       : v.margin,
		band         : v.band,
		/** The MIDDLE of the band — what is portable between engines, unlike the raw float. */
		prior        : v.prior,
		coverage     : dist.coverage,
		exactMass    : dist.exactMass,
		spacedMass   : dist.spacedMass,
		degraded     : dist.degraded,
		undecided    : undecided,
		theta        : theta,
		kind         : form.kind,
		options      : form.ids,
		letters      : letters,
		probabilities: dist.probabilities,
		byOption     : byOption,
		mass         : dist.mass,
		entries      : entries,
		prompt       : s.prompt === undefined ? null : s.prompt,
		request      : s.request === undefined ? null : s.request,
		raw          : resp,
		/** The distribution as a compact string — what belongs in a log, instead of one letter. */
		readoutRaw   : readout.rawOf(resp),
		ms           : s.ms === undefined ? null : s.ms,
		usage        : (resp && resp.usage) || null,
		model        : (resp && resp.model) || s.model || null,
	};
	if ( form.kind === 'score' ) {
		let e = 0;
		for ( let i = 0; i < form.values.length; i++ ) e += dist.probabilities[i] * form.values[i];
		/** The EXPECTATION of the scale — it uses the whole distribution, not just the top. It is
		 *  returned even when the decision abstains: abstention is about the verdict, not the mass. */
		out.expectation = dist.degraded ? null : e;
	}
	out.explain = () => 'notjev: ' + (dist.degraded
		? 'NO option mass — the model answered outside the codomain (' + (entries.slice(0, 5)
			.map(( x ) => JSON.stringify(x.token) ).join(', ') || 'empty distribution') + ')'
		: (undecided
			? 'UNDER THE MARGIN (p1 ' + v.p1.toFixed(3) + ' · margin ' + v.margin.toFixed(3)
				+ ' < theta ' + theta + ') — top would have been ' + JSON.stringify(v.top)
			: JSON.stringify(v.choice) + ' (p1 ' + v.p1.toFixed(3) + ' · margin ' + v.margin.toFixed(3)
				+ ' · band ' + v.band + ')'))
		+ ' · coverage ' + dist.coverage.toFixed(4);
	return out;
}

/* ── THE CLIENT ───────────────────────────────────────────────────────────────────────────── */

function createClient( options ) {
	const o = options || {};
	const env = o.env || process.env;
	const baseUrl = String(o.baseUrl || env.NOTJEV_BASE_URL || '').replace(/\/+$/, '');
	const model = o.model !== undefined ? o.model : env.NOTJEV_MODEL;
	const apiKey = o.apiKey !== undefined ? o.apiKey : env.NOTJEV_API_KEY;
	const theta0 = (o.theta !== undefined && o.theta !== null) ? Number(o.theta)
		: (env.NOTJEV_THETA !== undefined && env.NOTJEV_THETA !== '') ? Number(env.NOTJEV_THETA)
		: readout.THETA_DEFAULT;
	const path = o.path || DEFAULTS.path;
	const timeoutMs = o.timeoutMs === undefined ? DEFAULTS.timeoutMs : Number(o.timeoutMs);
	const retries = o.retries === undefined ? DEFAULTS.retries : Number(o.retries);
	const retryDelayMs = o.retryDelayMs === undefined ? DEFAULTS.retryDelayMs : Number(o.retryDelayMs);
	const doFetch = o.fetch || globalThis.fetch;
	const concurrency0 = o.concurrency === undefined ? DEFAULTS.concurrency : Number(o.concurrency);

	if ( !baseUrl )
		throw fail('NOTJEV_NO_BASE_URL', 'notjev: no `baseUrl`. Pass one, or set NOTJEV_BASE_URL. '
			+ 'This library never guesses a server: a wrong endpoint would answer, and answer wrong.');
	if ( typeof doFetch !== 'function' )
		throw fail('NOTJEV_NO_FETCH', 'notjev: no global `fetch` (Node >= 18) and none injected. '
			+ 'Pass `fetch` in the options.');

	/** THE EXACT BODY, so that it can be printed before it is sent (and diffed after). */
	function body( q ) {
		const form = formOf(q);
		const content = readout.renderTurn({
			state      : q.state,
			question   : q.question,
			options    : form.texts,
			instruction: q.instruction !== undefined ? q.instruction : o.instruction,
		});
		const params = readout.chatParams({
			model      : q.model !== undefined ? q.model : model,
			content    : content,
			maxTokens  : q.maxTokens !== undefined ? q.maxTokens : o.maxTokens,
			topLogprobs: q.topLogprobs !== undefined ? q.topLogprobs : o.topLogprobs,
		});
		if ( q.system !== undefined ? q.system : o.system )
			params.messages.unshift({ role: 'system', content: String(q.system !== undefined ? q.system : o.system) });
		// `templateKwargs`: undefined keeps the measured default; null/false REMOVES the field
		// (OpenAI rejects unknown body fields); an object replaces it.
		const tk = q.templateKwargs !== undefined ? q.templateKwargs : o.templateKwargs;
		if ( tk === null || tk === false ) delete params.chat_template_kwargs;
		else if ( tk !== undefined ) params.chat_template_kwargs = tk;
		Object.assign(params, o.extra || {}, q.extra || {});
		return { params: params, content: content, form: form };
	}

	/** The exact string that would be sent — the first rung of any diagnosis: READ the prompt. */
	function prompt( q ) { return body(q).content; }

	/**
	 * THE ONLY NETWORK CALL. A failure is NAMED (`NOTJEV_HTTP`, `NOTJEV_TIMEOUT`, `NOTJEV_NETWORK`,
	 * `NOTJEV_BAD_RESPONSE`) and only the transient ones are retried: retrying a 400 would hide a
	 * malformed body behind three identical refusals.
	 */
	async function post( params, more ) {
		const signal = more && more.signal;
		const url = baseUrl + path;
		const headers = Object.assign(
			{ 'Content-Type': 'application/json' },
			apiKey ? { Authorization: 'Bearer ' + apiKey } : {},
			o.headers || {},
			(more && more.headers) || {});
		const attempts = Math.max(1, retries + 1);
		let last = null;
		for ( let i = 0; i < attempts; i++ ) {
			if (signal) signal.throwIfAborted();
			const ctl = new AbortController();
			const cancel = () => ctl.abort(signal.reason);
			if (signal) signal.addEventListener('abort', cancel, { once: true });
			const timer = timeoutMs > 0 ? setTimeout(() => ctl.abort(), timeoutMs ) : null;
			const t0 = Date.now();
			let err = null;
			try {
				const r = await doFetch(url, {
					method : 'POST',
					headers: headers,
					body   : JSON.stringify(params),
					signal : ctl.signal,
				});
				if ( r.ok ) {
					const text = await r.text();
					let resp = null;
					try { resp = JSON.parse(text); }
					catch ( e ) {
						err = fail('NOTJEV_BAD_RESPONSE', 'notjev: ' + url + ' answered 200 with something that '
							+ 'is not JSON (' + JSON.stringify(String(text).slice(0, 200)) + '). An OpenAI-compatible '
							+ '`chat/completions` is expected — check the path and the proxy.', { body: text });
						err.transient = false;
					}
					if ( !err ) return { resp: resp, ms: Date.now() - t0, attempts: i + 1 };
				} else {
					const text = await r.text().catch(() => '' );
					err = fail('NOTJEV_HTTP', 'notjev: ' + url + ' answered HTTP ' + r.status + ' — '
						+ String(text).slice(0, 400), { status: r.status, body: text });
					err.transient = transient(r.status);
				}
			} catch ( e ) {
				const aborted = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
				err = aborted
					? fail('NOTJEV_TIMEOUT', 'notjev: ' + url + ' did not answer within ' + timeoutMs
						+ ' ms (attempt ' + (i + 1) + '/' + attempts + ').', { cause: e })
					: fail('NOTJEV_NETWORK', 'notjev: ' + url + ' unreachable — ' + ((e && e.message) || e)
						+ ' (attempt ' + (i + 1) + '/' + attempts + ').', { cause: e });
				err.transient = true;
			} finally {
				if ( timer ) clearTimeout(timer);
				if (signal) signal.removeEventListener('abort', cancel);
			}
			if (signal) signal.throwIfAborted();
			last = err;
			err.attempt = i + 1;
			if ( !err.transient || i === attempts - 1 ) throw err;
			await sleep(retryDelayMs * Math.pow(2, i));
		}
		throw last || fail('NOTJEV_NETWORK', 'notjev: ' + url + ' — no attempt succeeded.');
	}

	/** ONE readout: the exact string out, the distribution in, a verdict or an abstention. */
	async function decide( q ) {
		const b = body(q || {});
		const t0 = Date.now();
		const r = await post(b.params, { signal: q && q.signal });
		return readResponse(r.resp, {
			form   : b.form,
			theta  : q && q.theta !== undefined && q.theta !== null ? q.theta : theta0,
			edges  : (q && q.edges) || o.edges,
			prompt : b.content,
			request: b.params,
			ms     : Date.now() - t0,
			model  : b.params.model,
		});
	}

	/**
	 * A BOOLEAN QUESTION — with the two options SUPPLIED BY THE CALLER.
	 * `noul(state, question, { yes, no })`. Without a pair, the literals `true`/`false` are used.
	 * `value` is `true` when the chosen option is the `yes` one, `false` for the `no` one, `null`
	 * when the margin abstains.
	 */
	async function noul( state, question, pair, more ) {
		return decide(Object.assign({}, more || {}, {
			state   : state,
			question: question,
			noul    : pair === undefined || pair === null ? true : pair,
		}));
	}

	/** A SCALE — the choice is read on the digits, and the EXPECTATION uses the whole distribution. */
	async function score( state, question, range, more ) {
		return decide(Object.assign({}, more || {}, {
			state   : state,
			question: question,
			score   : range === undefined || range === null ? { min: 1, max: 5 } : range,
		}));
	}

	/**
	 * N QUESTIONS ON THE SAME STATE — one request each (that is the point: one token read per
	 * question), sequential by default. The server's prefix cache does the rest: the state is
	 * identical across the batch, so only the tail is recomputed.
	 */
	async function decideMany( state, questions, opts ) {
		const qs = (questions || []).map(( q, i ) => Object.assign({ id: q && q.id !== undefined ? q.id : i },
			q, { state: q && q.state !== undefined ? q.state : state }));
		const n = Math.max(1, Number((opts && opts.concurrency) || concurrency0));
		const onError = (opts && opts.onError) || 'throw';
		const out = new Array(qs.length);
		let next = 0;
		const workers = [];
		for ( let k = 0; k < Math.min(n, qs.length); k++ ) workers.push((async () => {
			for ( ;; ) {
				const j = next++;
				if ( j >= qs.length ) return;
				try {
					const r = await decide(qs[j]);
					r.id = qs[j].id;
					r.question = qs[j].question;
					out[j] = r;
				} catch ( e ) {
					if ( onError !== 'collect' ) throw e;
					out[j] = { id: qs[j].id, question: qs[j].question, ok: false, error: String(e && e.message || e),
						code: (e && e.code) || null, choice: null, value: null, undecided: true };
				}
				if ( opts && typeof opts.onResult === 'function' ) opts.onResult(out[j], j, qs.length);
			}
		})());
		await Promise.all(workers);
		return out;
	}

	/** The served models, for a one-line check that the URL and the name match. */
	async function models() {
		const r = await doFetch(baseUrl + '/v1/models', {
			headers: apiKey ? { Authorization: 'Bearer ' + apiKey } : {},
		});
		if ( !r.ok ) throw fail('NOTJEV_HTTP', 'notjev: ' + baseUrl + '/v1/models answered HTTP ' + r.status,
			{ status: r.status });
		return r.json();
	}

	return {
		baseUrl: baseUrl, model: model, theta: theta0, path: path,
		decide, noul, score, decideMany, prompt, body, models, readResponse,
	};
}

/** Which HTTP statuses are worth a second attempt — a 4xx that is not a rate limit is not. */
function transient( status ) {
	return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function sleep( ms ) { return new Promise(( r ) => setTimeout(r, ms) ); }

module.exports = { createClient, readResponse, formOf, optionOf, DEFAULTS };
