'use strict';

const { fail } = require('./errors');
const pkg = require('../package.json');

const contextSchema = { type: 'object', properties: {
	type: { enum: ['fresh', 'messages', 'snapshot', 'current'] }, state: { type: 'string' },
	messages: { type: 'array', items: { type: 'object', additionalProperties: true } },
	ref: { type: 'string' }, model: { type: 'string' }, tools: { type: 'array', items: { type: 'object' } },
	templateKwargs: { anyOf: [{ type: 'object' }, { type: 'null' }, { const: false }] }
}, additionalProperties: false };
const questionSchema = { type: 'object', required: ['question'], properties: {
	id: { type: 'string' }, question: { type: 'string' }, instruction: { type: 'string' },
	options: { type: 'array', minItems: 2, maxItems: 26, items: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'object' }] } },
	noul: { anyOf: [{ const: true }, { type: 'object' }] },
	score: { anyOf: [{ type: 'number' }, { type: 'object' }] }, theta: { type: 'number', minimum: 0, maximum: 1 }
}, additionalProperties: false };

const TOOLS = [
	{ name: 'notjev_decide', description: 'Answer closed questions on explicit data or an immutable context reference. Independent questions share the same context. A null choice means abstention. Context current requires the configured NotJev gateway; MCP alone has no conversation access.',
		inputSchema: { type: 'object', required: ['questions'], properties: { context: contextSchema,
			questions: { type: 'array', minItems: 1, maxItems: 64, items: questionSchema }, execution: { const: 'independent' } }, additionalProperties: false } },
	{ name: 'notjev_context_put', description: 'Store explicit context once for subsequent decision batches. Returns an expiring immutable reference.',
		inputSchema: { type: 'object', required: ['context'], properties: { context: contextSchema }, additionalProperties: false } },
	{ name: 'notjev_context_drop', description: 'Release a stored context reference.',
		inputSchema: { type: 'object', required: ['ref'], properties: { ref: { type: 'string' } }, additionalProperties: false } }
];

async function createMcpServer({ service, scope = 'local' }) {
	let Server, schemas;
	try {
		({ Server } = require('@modelcontextprotocol/sdk/server/index.js'));
		schemas = require('@modelcontextprotocol/sdk/types.js');
	} catch (e) { throw fail('NOTJEV_MCP_MISSING', 'Install optional peer @modelcontextprotocol/sdk to use MCP', { cause: e }); }
	const server = new Server({ name: 'notjev', version: pkg.version }, { capabilities: { tools: {} } });
	server.setRequestHandler(schemas.ListToolsRequestSchema, async () => ({ tools: TOOLS }));
	server.setRequestHandler(schemas.CallToolRequestSchema, async (req, extra) => {
		try {
			const args = req.params.arguments || {};
			let result;
			switch (req.params.name) {
				case 'notjev_decide': result = await service.decide(args, { scope, signal: extra.signal }); break;
				case 'notjev_context_put':
					if (!args.context || Object.keys(args).some(k => k !== 'context')) throw fail('NOTJEV_BAD_REQUEST', 'Supply context only');
					result = await service.putContext(args.context, { scope }); break;
				case 'notjev_context_drop':
					if (typeof args.ref !== 'string' || Object.keys(args).some(k => k !== 'ref')) throw fail('NOTJEV_BAD_REQUEST', 'Supply ref only');
					result = await service.dropContext(args.ref, { scope }); break;
				default: throw fail('NOTJEV_NO_TOOL', 'Unknown tool: ' + req.params.name);
			}
			return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
		} catch (e) {
			return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: e.code || 'NOTJEV_ERROR', message: e.message } }) }] };
		}
	});
	return server;
}

async function serveStdio(options) {
	const server = await createMcpServer(options);
	const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
	await server.connect(new StdioServerTransport());
	return server;
}

module.exports = { TOOLS, createMcpServer, serveStdio };
