'use strict';

const http = require('node:http');
const { once } = require('node:events');
const { fail } = require('./errors');
const { positive } = require('./context');

async function readJson(req, limit) {
	let size = 0; const chunks = [];
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limit) throw fail('NOTJEV_BODY_LIMIT', 'Request exceeds body limit');
		chunks.push(chunk);
	}
	try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
	catch (e) { throw fail('NOTJEV_BAD_JSON', 'Expected JSON request body'); }
}
function send(res, status, body) {
	res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
}

/** Bind only explicit `current` requests. Existing fresh/snapshot requests are never overwritten. */
function createBinder(body, service, scope, toolName) {
	let snapshot;
	return function bind(call) {
		if (call.function?.name !== toolName) return call;
		let args;
		try { args = JSON.parse(call.function.arguments); } catch (_) { return call; }
		if (args?.context?.type !== 'current') return call;
		if (Object.keys(args.context).some(k => k !== 'type')) throw fail('NOTJEV_BAD_CONTEXT', 'current context takes no other fields');
		if (!snapshot) snapshot = service.putContext({ type: 'messages', messages: body.messages,
			...(body.model ? { model: body.model } : {}), ...(body.tools ? { tools: body.tools } : {}),
			...(body.chat_template_kwargs !== undefined ? { templateKwargs: body.chat_template_kwargs } : {}) }, { scope });
		args.context = { type: 'snapshot', ref: snapshot.ref };
		return { ...call, function: { ...call.function, arguments: JSON.stringify(args) } };
	};
}

/** Buffer tool arguments until complete; ordinary content continues streaming. */
async function relaySse(upstream, res, bind, limit) {
	const decoder = new TextDecoder(), calls = new Map();
	let buffer = '', argumentBytes = 0, done = false;
	async function write(data) { if (!res.write(data)) await once(res, 'drain'); }
	async function event(text) {
		const data = text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
		if (!data) return;
		if (data === '[DONE]') {
			if (calls.size) throw fail('NOTJEV_TRUNCATED_STREAM', 'Stream ended with unfinished tool calls');
			done = true; await write('data: [DONE]\n\n'); return;
		}
		if (done) throw fail('NOTJEV_BAD_STREAM', 'Data after stream completion');
		let chunk;
		try { chunk = JSON.parse(data); } catch (_) { throw fail('NOTJEV_BAD_STREAM', 'Malformed upstream SSE JSON'); }
		for (const choice of chunk.choices || []) {
			const delta = choice.delta || {};
			for (const part of delta.tool_calls || []) {
				if (!Number.isInteger(part.index)) throw fail('NOTJEV_BAD_STREAM', 'Tool delta has no index');
				let map = calls.get(choice.index);
				if (!map) { map = new Map(); calls.set(choice.index, map); }
				let call = map.get(part.index);
				if (!call) { call = { index: part.index, function: { name: '', arguments: '' } }; map.set(part.index, call); }
				if (part.id) call.id = part.id;
				if (part.type) call.type = part.type;
				call.function.name += part.function?.name || '';
				call.function.arguments += part.function?.arguments || '';
				argumentBytes += Buffer.byteLength(JSON.stringify(part));
				if (argumentBytes > limit) throw fail('NOTJEV_BODY_LIMIT', 'Tool output exceeds buffer limit');
			}
			if (delta.tool_calls) delete delta.tool_calls;
			if (choice.finish_reason && calls.has(choice.index)) {
				if (choice.finish_reason !== 'tool_calls') throw fail('NOTJEV_TRUNCATED_STREAM', 'Tool generation did not complete');
				delta.tool_calls = [...calls.get(choice.index).values()].sort((a, b) => a.index - b.index).map(call => {
					if (!call.id || call.type !== 'function' || !call.function.name) throw fail('NOTJEV_BAD_STREAM', 'Incomplete tool metadata');
					try { JSON.parse(call.function.arguments); } catch (_) { throw fail('NOTJEV_BAD_STREAM', 'Incomplete tool arguments'); }
					return bind(call);
				});
				calls.delete(choice.index);
			}
		}
		await write('data: ' + JSON.stringify(chunk) + '\n\n');
	}
	for await (const bytes of upstream.body) {
		buffer += decoder.decode(bytes, { stream: true });
		// CRLF may be split across incoming network chunks; normalize only complete events.
		let match;
		while ((match = /\r?\n\r?\n/.exec(buffer))) {
			const text = buffer.slice(0, match.index).replace(/\r\n/g, '\n');
			buffer = buffer.slice(match.index + match[0].length); await event(text);
		}
		if (Buffer.byteLength(buffer) > limit) throw fail('NOTJEV_BODY_LIMIT', 'SSE event exceeds buffer limit');
	}
	buffer += decoder.decode();
	if (!done || calls.size || buffer.trim()) throw fail('NOTJEV_TRUNCATED_STREAM', 'Upstream SSE ended without a complete terminal event');
	res.end();
}

function createGateway(options) {
	const { service } = options;
	const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
	const scope = options.scope || 'local';
	const bodyLimit = positive(options.bodyLimit, 16 * 1024 * 1024, 'bodyLimit');
	const timeoutMs = positive(options.timeoutMs, 120000, 'timeoutMs');
	const doFetch = options.fetch || globalThis.fetch;
	return http.createServer(async (req, res) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		res.on('close', () => { if (!res.writableEnded) controller.abort(); });
		try {
			const path = new URL(req.url, 'http://localhost').pathname;
			/* /health is free, like the core serve: a probe must speak without a token. */
			if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });
			if (options.apiKey && req.headers.authorization !== 'Bearer ' + options.apiKey)
				return send(res, 401, { error: { code: 'NOTJEV_UNAUTHORIZED', message: 'Invalid gateway token' } });
			const control = { scope, signal: controller.signal };
			if (req.method === 'POST' && path.startsWith('/notjev/')) {
				const body = await readJson(req, bodyLimit);
				if (path === '/notjev/decide') return send(res, 200, await service.decide(body, control));
				if (path === '/notjev/context/put') return send(res, 200, await service.putContext(body, control));
				if (path === '/notjev/context/drop') return send(res, 200, await service.dropContext(body.ref, control));
			}
			if (!baseUrl || !((req.method === 'POST' && path === '/v1/chat/completions') || (req.method === 'GET' && path === '/v1/models')))
				return send(res, 404, { error: { code: 'NOTJEV_NO_ROUTE', message: 'Unknown gateway route' } });
			const body = req.method === 'POST' ? await readJson(req, bodyLimit) : undefined;
			const upstream = await doFetch(baseUrl + path, { method: req.method, signal: controller.signal,
				headers: { 'content-type': 'application/json', ...(options.upstreamApiKey ? { authorization: 'Bearer ' + options.upstreamApiKey } : {}) },
				...(body ? { body: JSON.stringify(body) } : {}) });
			if (!upstream.ok) return send(res, upstream.status, { error: { code: 'NOTJEV_UPSTREAM', message: (await upstream.text()).slice(0, 2000) } });
			const bind = body ? createBinder(body, service, scope, options.toolName || 'notjev_decide') : call => call;
			if (body?.stream) {
				res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
				await relaySse(upstream, res, bind, bodyLimit);
			} else {
				const output = await upstream.json();
				for (const choice of output.choices || []) if (choice.message?.tool_calls) {
					if (choice.finish_reason !== 'tool_calls') throw fail('NOTJEV_TRUNCATED_STREAM', 'Tool generation did not complete');
					choice.message.tool_calls = choice.message.tool_calls.map(bind);
				}
				send(res, 200, output);
			}
		} catch (e) {
			if (res.headersSent) res.destroy();
			else send(res, e.code === 'NOTJEV_BODY_LIMIT' ? 413 : 400, { error: { code: e.code || 'NOTJEV_GATEWAY_ERROR', message: e.message } });
		} finally { clearTimeout(timer); }
	});
}

function createRemoteService({ baseUrl, apiKey, fetch: doFetch = globalThis.fetch }) {
	async function call(path, body, options = {}) {
		let r;
		try {
			r = await doFetch(baseUrl.replace(/\/+$/, '') + '/notjev/' + path, { method: 'POST', signal: options.signal,
				headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}) }, body: JSON.stringify(body) });
		} catch (e) {
			if (e.code) throw e;
			throw fail('NOTJEV_HTTP', 'Gateway request failed: ' + (e.message || e));
		}
		const data = await r.json();
		if (!r.ok) throw fail(data.error?.code || 'NOTJEV_GATEWAY_ERROR', data.error?.message || 'Gateway request failed');
		return data;
	}
	return { decide: (input, o) => call('decide', input, o), putContext: (input, o) => call('context/put', input, o),
		dropContext: (ref, o) => call('context/drop', { ref }, o), async close() {} };
}

module.exports = { createGateway, createRemoteService, createBinder, relaySse };
