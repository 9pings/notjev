'use strict';
/**
 * @file lib/server.js — THE SAME READOUT, BEHIND ONE HTTP ROUTE.
 *
 * `POST /v1/decide` with `{ state, questions: [...] }` returns one typed answer per question, on
 * ONE state, with N one-token requests behind it. The shape is close to what a "system one" style
 * service exposes; it does NOT claim to be compatible with any of them, and it says so.
 *
 * What it adds over calling the library directly: a process boundary (any language can ask), and
 * one place where the model, the theta and the timeout are configured for a whole fleet.
 * What it deliberately does NOT add: a queue, a cache, an auth layer, a metrics endpoint. Those
 * belong to the host, and a library that grows them becomes a server nobody can replace.
 */

const http = require('http');
const { createClient } = require('./client');

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
 * @param opts `{ client? , ...createClient options, bodyLimit?, log? }`
 * @returns a `http.Server` — the caller listens, so tests can take an ephemeral port.
 */
function createServer( opts ) {
	const o = opts || {};
	const client = o.client || createClient(o);
	const bodyLimit = o.bodyLimit || 8 * 1024 * 1024;
	const log = o.log === undefined ? ( ...a ) => console.log(...a) : o.log;

	const server = http.createServer(async ( req, res ) => {
		const url = new URL(req.url, 'http://localhost');
		try {
			if ( req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/') )
				return send(res, 200, { ok: true, baseUrl: client.baseUrl, model: client.model || null, theta: client.theta });

			if ( req.method !== 'POST' || url.pathname !== '/v1/decide' )
				return send(res, 404, { error: { code: 'NOTJEV_NO_ROUTE',
					message: 'notjev: only `POST /v1/decide` and `GET /health` exist here.' } });

			const text = await readBody(req, bodyLimit);
			let body = null;
			try { body = JSON.parse(text || '{}'); }
			catch ( e ) {
				return send(res, 400, { error: { code: 'NOTJEV_BAD_JSON', message: 'notjev: the body is not JSON.' } });
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
