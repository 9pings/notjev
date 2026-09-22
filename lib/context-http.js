'use strict';

const { createClient } = require('./client');
const { copy } = require('./context');
const { fail } = require('./errors');

function createHttpContextBackend(options = {}) {
	const client = options.client || createClient(options);
	return {
		model: client.model,
		async decideContext({ context, question, signal }) {
			if (context.model && context.model !== client.model)
				throw fail('NOTJEV_MODEL_MISMATCH', 'Snapshot model differs from the configured decision model');
			const messages = copy(context.messages);
			messages.push({ role: 'user', content: client.prompt(question) });
			const extra = { messages, max_tokens: 1, logprobs: true, stream: false };
			if (context.tools?.length) { extra.tools = context.tools; extra.tool_choice = 'none'; }
			const r = await client.decide({ ...question, signal, extra,
				...(context.templateKwargs !== undefined ? { templateKwargs: context.templateKwargs } : {}) });
			r.cache = { status: 'unknown', ...(r.usage?.prompt_tokens_details?.cached_tokens !== undefined
				? { status: 'reported', cachedTokens: r.usage.prompt_tokens_details.cached_tokens } : {}) };
			return r;
		}
	};
}

module.exports = { createHttpContextBackend };
