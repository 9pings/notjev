'use strict';

const { createDecisionService } = require('./service');
const { createHttpContextBackend } = require('./context-http');
const { createGateway, createRemoteService } = require('./gateway');

async function runContextCommand(command, args) {
	const baseUrl = args['base-url'] || process.env.NOTJEV_BASE_URL;
	const gatewayKey = args['gateway-key'] || process.env.NOTJEV_GATEWAY_KEY;
	const model = args.model || process.env.NOTJEV_MODEL;
	const modelPath = args['model-path'] || process.env.NOTJEV_MODEL_PATH;
	let service;
	if (args['service-url']) {
		if (command !== 'mcp') throw new Error('--service-url is for MCP connecting to an existing gateway');
		service = createRemoteService({ baseUrl: args['service-url'], apiKey: gatewayKey });
	} else {
		const backendName = args.backend || (modelPath ? 'native' : 'http');
		if (!['native', 'http'].includes(backendName)) throw new Error('--backend must be native or http');
		const backend = backendName === 'native'
			? await require('./context-native').createNativeContextBackend({ modelPath, model,
				gpu: args.gpu === 'false' ? false : args.gpu || 'auto', requireGpu: !!args['require-gpu'],
				contextSize: args['context-size'] === undefined ? undefined : Number(args['context-size']), mmproj: args.mmproj })
			: createHttpContextBackend({ baseUrl, model, apiKey: args['api-key'] || process.env.NOTJEV_API_KEY,
				templateKwargs: args['no-template-kwargs'] ? null : undefined });
		service = createDecisionService({ backend, ownsBackend: true,
			concurrency: args.concurrency === undefined ? undefined : Number(args.concurrency),
			timeoutMs: args.timeout === undefined ? undefined : Number(args.timeout) });
	}
	let server;
	try {
		if (command === 'mcp') server = await require('./mcp').serveStdio({ service });
		else {
			const host = args.host || '127.0.0.1';
			if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !gatewayKey) throw new Error('A non-loopback gateway requires --gateway-key');
			server = createGateway({ service, baseUrl, apiKey: gatewayKey,
				upstreamApiKey: args['api-key'] || process.env.NOTJEV_API_KEY, toolName: args['tool-name'] });
			await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(args.port || 8789), host, resolve); });
			process.stderr.write('notjev gateway listening on http://' + host + ':' + server.address().port + '\n');
		}
	} catch (e) { await service.close(); throw e; }
	return new Promise((resolve, reject) => {
		let closing = false;
		async function stop() {
			if (closing) return; closing = true;
			process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); process.stdin.removeListener('end', stop);
			try {
				if (command === 'gateway') {
					const closed = new Promise(r => server.close(r)); server.closeAllConnections();
					await service.close(); await closed;
				} else { await server.close(); await service.close(); }
				resolve(0);
			} catch (e) { reject(e); }
		}
		process.once('SIGINT', stop); process.once('SIGTERM', stop);
		if (command === 'mcp') { process.stdin.once('end', stop); if (process.stdin.readableEnded) stop(); }
	});
}

module.exports = { runContextCommand };
