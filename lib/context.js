'use strict';

const { randomUUID } = require('node:crypto');
const { fail } = require('./errors');

function bad(message) { return fail('NOTJEV_BAD_CONTEXT', message); }
function copy(value) {
	try { return JSON.parse(JSON.stringify(value)); }
	catch (e) { throw bad('Context must be JSON serializable: ' + e.message); }
}
function positive(value, fallback, name) {
	const n = value === undefined ? fallback : value;
	if (!Number.isSafeInteger(n) || n <= 0) throw bad(name + ' must be a positive integer');
	return n;
}

/** Validate complete tool exchanges; preserve roles and multimodal parts verbatim. */
function validateMessages(messages) {
	if (!Array.isArray(messages)) throw bad('messages must be an array');
	const pending = new Set(), seen = new Set();
	for (const m of messages) {
		if (!m || !['system', 'developer', 'user', 'assistant', 'tool'].includes(m.role))
			throw bad('Unsupported message role');
		if (pending.size && m.role !== 'tool') throw bad('Tool calls must have their results before the next message');
		if (m.role === 'tool') {
			if (!pending.delete(m.tool_call_id)) throw bad('Unmatched tool result: ' + m.tool_call_id);
		}
		if (m.tool_calls !== undefined) {
			if (m.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length)
				throw bad('tool_calls requires an assistant message and a nonempty array');
			for (const call of m.tool_calls) {
				if (!call || typeof call.id !== 'string' || !call.id || seen.has(call.id)
					|| call.type !== 'function' || typeof call.function?.name !== 'string'
					|| typeof call.function?.arguments !== 'string') throw bad('Invalid or duplicate tool call');
				seen.add(call.id); pending.add(call.id);
			}
		}
		if (typeof m.content === 'string') continue;
		if (m.content == null && m.role === 'assistant' && m.tool_calls) continue;
		if (!Array.isArray(m.content)) throw bad('Message content must be text or content parts');
		for (const part of m.content) {
			if (part?.type === 'text' && typeof part.text === 'string') continue;
			if (part?.type === 'image_url' && typeof part.image_url?.url === 'string'
				&& /^(https?:\/\/|data:image\/)/.test(part.image_url.url)) continue;
			throw bad('Supported content parts: text and image_url (HTTP URL or image data URL)');
		}
	}
	if (pending.size) throw bad('Context ends with unresolved tool calls');
}

/** Snapshot data contains rendering inputs, never upstream credentials or arbitrary request overrides. */
function normalizeContext(input = { type: 'fresh' }) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Invalid context');
	const type = input.type || 'fresh';
	if (!['fresh', 'messages'].includes(type)) throw bad('Expected fresh or messages context');
	const allowed = new Set(['type', 'state', 'messages', 'model', 'tools', 'templateKwargs']);
	for (const key of Object.keys(input)) if (!allowed.has(key)) throw bad('Unknown context field: ' + key);
	if (input.state !== undefined && input.messages !== undefined) throw bad('Use state or messages, not both');
	if (input.state != null && typeof input.state !== 'string') throw bad('state must be text');
	if (type === 'messages' && !Array.isArray(input.messages)) throw bad('messages context requires messages');
	const out = copy({ type, messages: input.messages || (input.state != null ? [{ role: 'user', content: input.state }] : []) });
	validateMessages(out.messages);
	if (input.model !== undefined) {
		if (typeof input.model !== 'string' || !input.model) throw bad('model must be a nonempty string');
		out.model = input.model;
	}
	if (input.tools !== undefined) {
		if (!Array.isArray(input.tools)) throw bad('tools must be an array');
		out.tools = copy(input.tools);
	}
	if (input.templateKwargs !== undefined) {
		if (input.templateKwargs !== null && input.templateKwargs !== false
			&& (typeof input.templateKwargs !== 'object' || Array.isArray(input.templateKwargs))) throw bad('Invalid templateKwargs');
		out.templateKwargs = copy(input.templateKwargs);
	}
	return out;
}

/** Bounded immutable snapshots. Leases pin data, not references that can still be resolved. */
function createContextStore(options = {}) {
	const maxEntries = positive(options.maxEntries, 128, 'maxEntries');
	const maxBytes = positive(options.maxBytes, 64 * 1024 * 1024, 'maxBytes');
	const ttlMs = positive(options.ttlMs, 15 * 60 * 1000, 'ttlMs');
	const now = options.clock || Date.now;
	const entries = new Map();
	let bytes = 0;
	function remove(ref, e) { entries.delete(ref); bytes -= e.bytes; }
	function sweep() {
		for (const [ref, e] of entries) if (!e.readers && (e.dropped || now() >= e.expiresAt)) remove(ref, e);
	}
	function resolve(ref, scope) {
		sweep();
		const e = entries.get(ref);
		if (!e || e.scope !== scope || e.dropped || now() >= e.expiresAt)
			throw fail('NOTJEV_CONTEXT_UNAVAILABLE', 'Context reference is missing, expired or outside this scope');
		return e;
	}
	return {
		put(input, scope = 'local') {
			const data = normalizeContext(input), json = JSON.stringify(data);
			const size = Buffer.byteLength(json);
			sweep();
			if (entries.size >= maxEntries || bytes + size > maxBytes)
				throw fail('NOTJEV_CONTEXT_LIMIT', 'Context store quota exceeded; release a reference or wait for expiry');
			const ref = 'ctx_' + randomUUID(), expiresAt = now() + ttlMs;
			entries.set(ref, { json, scope, expiresAt, bytes: size, readers: 0, dropped: false });
			bytes += size;
			return { ref, expiresAt, bytes: size };
		},
		acquire(ref, scope = 'local') {
			const e = resolve(ref, scope); e.readers++;
			let released = false;
			return { data: JSON.parse(e.json), release() {
				if (released) return;
				released = true; e.readers--; sweep();
			} };
		},
		drop(ref, scope = 'local') { const e = resolve(ref, scope); e.dropped = true; sweep(); return { dropped: true }; },
		stats() { sweep(); return { entries: entries.size, bytes }; },
		clear() { for (const e of entries.values()) e.dropped = true; sweep(); }
	};
}

module.exports = { createContextStore, normalizeContext, validateMessages, copy, positive };
