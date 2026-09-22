'use strict';
/**
 * @file lib/server.js — THE SAME READOUT, BEHIND TWO HTTP CONTRACTS.
 *
 * `POST /v1/decide` — the native route: `{ state, questions: [...] }`, one row per question, every
 * field of the Decision on the wire. It claims compatibility with nothing.
 *
 * `POST /v1/systemone` — THE JEV WIRE CONTRACT (`lib/wire.js`): `{ state, questions: { name:
 * { type, instructions, criteria } } }` and answers grouped as `{ nouls, choices, scores }`, with
 * FastAPI-shaped `422` detail lists. A `typesafe-sdk` (or anything that speaks the contract) pointed
 * at this server works unchanged — against ANY OpenAI-compatible engine the host configures.
 *
 * `GET /v1/models` lists the configured engine and the aliases (`jev-latest`, `jev-preview`) so an
 * SDK's default model name resolves — they all point at the same configured engine.
 *
 * What it adds over calling the library directly: a process boundary (any language can ask), and
 * one place where the model, the theta and the timeout are configured for a whole fleet. An OPTIONAL
 * `apiKey` turns the POST routes into bearer-guarded ones (Jev's `401` shape).
 * What it deliberately does NOT add: a queue, a cache, a metrics endpoint. Those belong to the host,
 * and a library that grows them becomes a server nobody can replace.
 */

const http = require('http');
const { createClient } = require('./client');
const wire = require('./wire');

/** Fields that are heavy and rarely wanted over the wire — returned only on `raw: true`. */
const HEAVY = ['raw', 'entries', 'request', 'prompt', 'mass', 'readoutRaw'];

function publicResult( r, withRaw ) {
	const out = {};
	for ( const k of Object.keys(r) ) {
		if ( typeof r[k] === 'function' ) continue;
		if ( !withRaw && HEAVY.indexOf(k) >= 0 ) continue;
		out[k] = r[k];
	}
	return out;
}

function readBody( req, limit ) {
	return new Promise(( resolve, reject ) => {
		let n = 0;
		const chunks = [];
		req.on('data', ( c ) => {
			n += c.length;
			if ( n > limit ) { reject(Object.assign(new Error('body over ' + limit + ' bytes'), { status: 413 })); req.destroy(); return; }
			chunks.push(c);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')) );
		req.on('error', reject);
	});
}

function send( res, status, obj ) {
	const body = JSON.stringify(obj, null, 1);
	res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
	res.end(body);
}

/**
 * @param opts `{ client? , ...createClient options, apiKey?, bodyLimit?, log? }`
 * @returns a `http.Server` — the caller listens, so tests can take an ephemeral port.
 */
function createServer( opts ) {
	const o = opts || {};
	const client = o.client || createClient(o);
	const bodyLimit = o.bodyLimit || 8 * 1024 * 1024;
	const apiKey = o.apiKey || null;
	const log = o.log === undefined ? ( ...a ) => console.log(...a) : o.log;

	/** The Jev auth shape: `{"detail": {"error_type", "message"}}`, on the 401 the SDKs parse. */
	function unauthorized( res ) {
		return send(res, 401, { detail: { error_type: 'unauthorized',
			message: 'notjev: a bearer token is required here (the server was configured with one).' } });
	}
	function badToken( res ) {
		return send(res, 401, { detail: { error_type: 'unauthorized',
			message: 'notjev: the bearer token does not match the key this server is configured with.' } });
	}
	function authedWith( req ) {
		if ( !apiKey ) return true;
		const h = req.headers.authorization || '';
		if ( !/^Bearer\s+/i.test(h) ) return unauthorized;
		if ( h.replace(/^Bearer\s+/i, '').trim() !== apiKey ) return badToken;
		return true;
	}

	const server = http.createServer(async ( req, res ) => {
		const url = new URL(req.url, 'http://localhost');
		try {
			if ( req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/') )
				return send(res, 200, { ok: true, baseUrl: client.baseUrl, model: client.model || null, theta: client.theta });

			if ( req.method === 'GET' && url.pathname === '/v1/models' ) {
				const id = client.model || 'notjev';
				return send(res, 200, { object: 'list', data:
					[id, 'notjev-latest', 'jev-latest', 'jev-preview'].map(( x ) => ({ object: 'model', id: x })) });
			}

			if ( req.method !== 'POST' || (url.pathname !== '/v1/decide' && url.pathname !== '/v1/systemone') )
				return send(res, 404, { error: { code: 'NOTJEV_NO_ROUTE',
					message: 'notjev: only `POST /v1/decide`, `POST /v1/systemone`, `GET /v1/models` and `GET /health` exist here.' } });

			const auth = authedWith(req);
			if ( auth !== true ) return auth(res);

			const text = await readBody(req, bodyLimit);
			let body = null;
			try { body = JSON.parse(text || '{}'); }
			catch ( e ) {
				return send(res, 400, { error: { code: 'NOTJEV_BAD_JSON', message: 'notjev: the body is not JSON.' } });
			}

			/* ── THE JEV WIRE CONTRACT ────────────────────────────────────────────────────── */
			if ( url.pathname === '/v1/systemone' ) {
				let req2 = null;
				try { req2 = wire.toQuestions(body); }
				catch ( e ) {
					if ( e && e.code === 'NOTJEV_WIRE_422' )
						return send(res, 422, { detail: e.detail });
					throw e;
				}
				const t0 = Date.now();
				const results = await client.decideMany(req2.state, req2.questions,
					{ concurrency: body.concurrency, onError: 'collect' });
				try {
					const out = wire.toAnswers(req2.specs, results);
					const ms = Date.now() - t0;
					if ( log ) log('[notjev] systemone · ' + req2.questions.length + ' question(s) · '
						+ ms + ' ms · ' + results.filter(( r ) => r && r.undecided ).length + ' undecided');
					return send(res, 200, {
						model  : client.model || 'notjev',
						answers: out.answers,
						usage  : out.usage,
						ms     : ms,
					});
				} catch ( e ) {
					if ( e && e.code === 'NOTJEV_WIRE_UPSTREAM' )
						return send(res, 502, { detail: e.detail });
					throw e;
				}
			}

			const questions = body.questions || (body.question !== undefined ? [body] : null);
			if ( !Array.isArray(questions) || !questions.length )
				return send(res, 400, { error: { code: 'NOTJEV_NO_QUESTION', message: 'notjev: `questions: [...]` '
					+ 'is required (each one with `options`, `noul` or `score`). One state, N questions.' } });

			const t0 = Date.now();
			const results = await client.decideMany(body.state, questions.map(( q ) => Object.assign({}, q, {
				theta: q.theta !== undefined ? q.theta : body.theta,
			}) ), { concurrency: body.concurrency, onError: 'collect' });
			const ms = Date.now() - t0;
			if ( log ) log('[notjev] ' + questions.length + ' question(s) · ' + ms + ' ms · '
				+ results.filter(( r ) => r && r.undecided ).length + ' undecided');
			return send(res, 200, {
				model  : client.model || null,
				theta  : client.theta,
				ms     : ms,
				results: results.map(( r ) => publicResult(r, !!body.raw) ),
			});
		} catch ( e ) {
			const status = e && e.status ? e.status
				: (e && (e.code === 'NOTJEV_HTTP' || e.code === 'NOTJEV_TIMEOUT' || e.code === 'NOTJEV_NETWORK')) ? 502 : 400;
			return send(res, status, { error: { code: (e && e.code) || 'NOTJEV_ERROR',
				message: String((e && e.message) || e) } });
		}
	});
	server.notjev = { client: client };
	return server;
}

module.exports = { createServer };
