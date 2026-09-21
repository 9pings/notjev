'use strict';
/**
 * A FAKE `chat/completions` — an HTTP server that answers with a distribution the test chose.
 * It exists so that the client is tested against a REAL socket (headers, retries, timeouts, JSON)
 * rather than against a stubbed `fetch`: a stub cannot fail the way a server fails.
 */
const http = require('http');

/** `/v1/chat/completions` shape: `choices[0].logprobs.content[0].top_logprobs`. */
function chatResponse( pairs, extra ) {
	const top = pairs.map(( [token, logprob] ) => ({ token: token, logprob: logprob, bytes: null }) );
	return Object.assign({
		id     : 'chatcmpl-fake',
		object : 'chat.completion',
		model  : 'fake-model',
		choices: [{
			index   : 0,
			message : { role: 'assistant', content: pairs.length ? pairs[0][0] : '' },
			logprobs: { content: [{ token: pairs.length ? pairs[0][0] : '', logprob: pairs.length ? pairs[0][1] : 0,
				top_logprobs: top }] },
		}],
		usage: { prompt_tokens: 42, completion_tokens: 1, total_tokens: 43 },
	}, extra || {});
}

/** `/v1/completions` shape: `choices[0].logprobs.top_logprobs[0]` is an OBJECT. */
function completionsResponse( pairs ) {
	return {
		id     : 'cmpl-fake',
		choices: [{ logprobs: { top_logprobs: [pairs.reduce(( o, [t, lp] ) => (o[t] = lp, o), {})] } }],
	};
}

/** log-probabilities from plain probabilities, so tests read like the thing they assert. */
function lp( probs ) { return probs.map(( [t, p] ) => [t, Math.log(p)] ); }

/**
 * @param handler (body, req) -> { status?, json?, text?, delayMs?, headers? } | response object
 * @returns `{ url, port, requests, close() }`
 */
async function startFake( handler ) {
	const requests = [];
	const server = http.createServer(( req, res ) => {
		let data = '';
		req.on('data', ( c ) => { data += c; });
		req.on('end', async () => {
			let body = null;
			try { body = JSON.parse(data || '{}'); } catch ( e ) { body = { __unparsed: data }; }
			requests.push({ url: req.url, method: req.method, headers: req.headers, body: body });
			let out = null;
			try { out = await handler(body, req, requests.length); }
			catch ( e ) { out = { status: 500, json: { error: String(e.message || e) } }; }
			const spec = (out && (out.status || out.json || out.text || out.delayMs !== undefined))
				? out : { json: out };
			if ( spec.delayMs ) await new Promise(( r ) => setTimeout(r, spec.delayMs) );
			const payload = spec.text !== undefined ? spec.text : JSON.stringify(spec.json === undefined ? {} : spec.json);
			res.writeHead(spec.status || 200, Object.assign({ 'Content-Type': 'application/json' }, spec.headers || {}));
			res.end(payload);
		});
	});
	await new Promise(( r ) => server.listen(0, '127.0.0.1', r) );
	const port = server.address().port;
	return {
		url     : 'http://127.0.0.1:' + port,
		port    : port,
		requests: requests,
		close   : () => new Promise(( r ) => server.close(r) ),
	};
}

module.exports = { startFake, chatResponse, completionsResponse, lp };
