'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('../lib/backends/node-llama-cpp');

test('node-llama-cpp: la carte de probabilités devient des entries (logprob = log p)', () => {
	const m = new Map([[65, 0.9], [66, 0.05], [9, 0.01]]);
	const e = N.probsToEntries(m, ( id ) => ({ 65: 'A', 66: 'B', 9: ' A' })[id] );
	assert.deepEqual(e.map(( x ) => x.token ), ['A', 'B', ' A']);
	assert.ok(Math.abs(Math.exp(e[0].logprob) - 0.9) < 1e-12);
});
test('node-llama-cpp: le garde-fou VRAM refuse un run CPU déguisé', () => {
	assert.throws(() => N.guardVram({ requireGpu: true, before: 100, after: 100, gpuLayers: 0 }), ( e ) => e.code === 'SILENT_CPU_RUN');
	assert.doesNotThrow(() => N.guardVram({ requireGpu: true, before: 100, after: 5e9, gpuLayers: 40 }));
	assert.doesNotThrow(() => N.guardVram({ requireGpu: false, before: 0, after: 0, gpuLayers: 0 }));
});
test('node-llama-cpp: sans le module, createNodeLlamaClient refuse par son code', async ( t ) => {
	let present = true; try { require.resolve('node-llama-cpp'); } catch ( e ) { present = false; }
	if ( present ) return t.skip('node-llama-cpp installé — le refus ne se teste pas ici');
	await assert.rejects(N.createNodeLlamaClient({ modelPath: 'x.gguf' }), ( e ) => e.code === 'NODE_LLAMA_CPP_MISSING');
});

/* La carte rendue par `controlledEvaluate` porte TOUT le vocabulaire (~150 k pour Qwen3) : la
 * détokeniser entière coûterait 150 000 appels par position lue. `keep` force les ids des lettres
 * (et de leurs variantes espacées) dans les entries quelle que soit leur place — sans quoi une
 * lettre hors du top-N sortirait à masse nulle, et `coverage` mentirait vers le bas. */
test('node-llama-cpp: limit borne la détokenisation, keep garde les lettres même hors du top', () => {
	const m = new Map(); for ( let i = 0; i < 100; i++ ) m.set(1000 + i, 0.01);
	m.set(65, 1e-6);                                                         // 'A', loin derrière
	const seen = [];
	const e = N.probsToEntries(m, ( id ) => { seen.push(id); return id === 65 ? 'A' : 'x' + id; }, { limit: 5, keep: [65] });
	assert.equal(e.length, 6);                                               // 5 du top + la lettre gardée
	assert.equal(seen.length, 6);                                            // et 6 détokenisations, pas 101
	assert.ok(e.some(( x ) => x.token === 'A' ));
});
