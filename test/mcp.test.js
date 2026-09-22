'use strict';
/**
 * mcp.js — LE SERVEUR MCP, TESTÉ AVEC LE SDK OFFICIEL, EN MÉMOIRE.
 *
 * Le transport est la paire InMemory du SDK : ce sont de vrais appels de protocole (schémas,
 * sérialisation, isError), pas des appels de fonctions déguisés. Le SDK est une peer
 * OPTIONNELLE : sans lui, la suite se saute — le refus propre se teste ailleurs.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { createMcpServer, TOOLS } = require('../lib/mcp');
const { createDecisionService } = require('../lib/service');

const present = (() => { try { require.resolve('@modelcontextprotocol/sdk/package.json'); return true; } catch { return false; } })();

function fakeBackend() {
	return {
		model: 'fake-model',
		async decideContext({ context, question }) {
			assert.ok(context, 'le contexte normalisé part au backend');
			return { choice: 'ORANGE', value: 'ORANGE', p1: 0.9, margin: 0.8, coverage: 0.99, ms: 1 };
		},
	};
}

async function connected( scope = 'local' ) {
	const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
	const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
	const service = createDecisionService({ backend: fakeBackend() });
	const server = await createMcpServer({ service, scope });
	const client = new Client({ name: 'notjev-tests', version: '1.0.0' });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	await client.connect(clientSide);
	return { client, server, service,
		close: async () => { await client.close(); await server.close(); await service.close(); } };
}

(present ? describe : describe.skip)('mcp — les trois outils, par le SDK', () => {
	test('listTools expose les trois outils avec leurs schéma d\'entrée', async () => {
		const c = await connected();
		const { tools } = await c.client.listTools();
		assert.deepEqual(tools.map(( t ) => t.name).sort(), ['notjev_context_drop', 'notjev_context_put', 'notjev_decide']);
		const decide = tools.find(( t ) => t.name === 'notjev_decide');
		assert.equal(decide.inputSchema.required[0], 'questions');
		assert.deepEqual(decide.inputSchema.properties.context.properties.type.enum,
			['fresh', 'messages', 'snapshot', 'current']);
		const put = tools.find(( t ) => t.name === 'notjev_context_put');
		assert.deepEqual(put.inputSchema.properties.context.properties.type.enum, ['fresh', 'messages'],
			'put ne doit pas annoncer snapshot/current que le service refuse');
		assert.deepEqual(TOOLS.map(( t ) => t.name), tools.map(( t ) => t.name), 'la déclaration publique est celle servie');
		await c.close();
	});

	test('notjev_decide rend un résultat STRUCTURÉ et le même en texte', async () => {
		const c = await connected();
		const r = await c.client.callTool({ name: 'notjev_decide', arguments: {
			context: { type: 'fresh', state: 'Le code est ORANGE.' },
			questions: [{ id: 'code', question: 'Quel mot de code ?', options: ['ORANGE', 'BLUE'] }] } });
		assert.equal(r.structuredContent.results[0].choice, 'ORANGE');
		assert.equal(r.structuredContent.results[0].id, 'code');
		assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent, 'le texte est le même JSON');
		assert.equal(r.isError, undefined);
		await c.close();
	});

	test('put → snapshot → drop : le cycle complet, dans le SCOPE du serveur', async () => {
		const c = await connected('tenantA');
		const put = await c.client.callTool({ name: 'notjev_context_put', arguments: {
			context: { type: 'messages', messages: [{ role: 'user', content: 'Le code est ORANGE.' }] } } });
		const ref = put.structuredContent.ref;
		assert.match(ref, /^ctx_/);
		const decide = await c.client.callTool({ name: 'notjev_decide', arguments: {
			context: { type: 'snapshot', ref }, questions: [{ question: 'Quel mot de code ?', options: ['ORANGE', 'BLUE'] }] } });
		assert.equal(decide.structuredContent.contextRef, ref);
		const drop = await c.client.callTool({ name: 'notjev_context_drop', arguments: { ref } });
		assert.deepEqual(drop.structuredContent, { dropped: true });
		const gone = await c.client.callTool({ name: 'notjev_decide', arguments: {
			context: { type: 'snapshot', ref }, questions: [{ question: 'q ?', options: ['ORANGE', 'BLUE'] }] } });
		assert.ok(gone.isError, 'une référence lâchée est une erreur, pas un verdict');
		assert.equal(JSON.parse(gone.content[0].text).error.code, 'NOTJEV_CONTEXT_UNAVAILABLE');
		await c.close();
	});

	test('les erreurs remontent en isError AVEC leur code — jamais en crash de protocole', async () => {
		const c = await connected();
		for ( const [name, args, code] of [
			['notjev_inconnu', {}, 'NOTJEV_NO_TOOL'],
			['notjev_decide', { questions: [] }, 'NOTJEV_BAD_QUESTIONS'],
			['notjev_decide', { questions: [{ question: 'q ?', options: ['ORANGE'] }] }, 'NOTJEV_ERROR'],
			['notjev_decide', { context: { type: 'current' }, questions: [{ question: 'q ?', options: ['ORANGE', 'BLUE'] }] }, 'NOTJEV_BAD_CONTEXT'],
			['notjev_context_put', { context: { state: 'x' }, rogue: 1 }, 'NOTJEV_BAD_REQUEST'],
			['notjev_context_drop', { ref: 'x', extra: 1 }, 'NOTJEV_BAD_REQUEST'],
			['notjev_context_drop', {}, 'NOTJEV_BAD_REQUEST'],
		] ) {
			const r = await c.client.callTool({ name, arguments: args });
			assert.equal(r.isError, true, name + ' doit être une erreur d\'outil');
			assert.equal(JSON.parse(r.content[0].text).error.code, code, name + ' → ' + code);
		}
		await c.close();
	});

	test('le scope isole : une référence posée par un serveur est invisible au service nu', async () => {
		const c = await connected('tenantA');
		const put = await c.client.callTool({ name: 'notjev_context_put', arguments: {
			context: { type: 'messages', messages: [] } } });
		const ref = put.structuredContent.ref;
		assert.throws(() => c.service.store.acquire(ref, 'local'), { code: 'NOTJEV_CONTEXT_UNAVAILABLE' });
		assert.ok(c.service.store.acquire(ref, 'tenantA'));
		await c.close();
	});
});

test('mcp: sans le SDK, le serveur refuse par son code (pas une stack de resolver)', async ( t ) => {
	if ( present ) return t.skip('@modelcontextprotocol/sdk installé — le refus ne se teste pas ici');
	await assert.rejects(createMcpServer({ service: null }), ( e ) => e.code === 'NOTJEV_MCP_MISSING');
});
