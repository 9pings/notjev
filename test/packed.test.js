'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/packed');
const chatml = require('../lib/chatml');
const fix = require('./fixtures/treillis_packed_s1.json');

const charTok = async ( s ) => s.split('').map(( c ) => c.charCodeAt(0) );   // 1 char = 1 token

test('chatml: un tour assistant ouvert finit sur le slot de réponse, thinking fermé', () => {
	const s = chatml.render([{ role: 'user', content: 'Q' }, { role: 'assistant', content: null }], { thinkingOff: true });
	assert.equal(s, '<|im_start|>user\nQ<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n');
});

test('packed: l\'état est écrit UNE fois, chaque question a son slot, les positions pointent le placeholder', async () => {
	const p = await P.buildPacked({ state: 'S', tokenize: charTok, questions: [
		{ id: 'q1', question: 'one', options: ['a', 'b'] }, { id: 'q2', question: 'two', options: ['x', 'y', 'z'] } ] });
	assert.equal((p.prompt.match(/Context:\nS/g) || []).length, 1);
	assert.equal(p.positions.length, 2);
	for ( const pos of p.positions ) assert.equal(p.prompt[pos], '_');          // charTok : index = position
	assert.deepEqual(p.slots[1].letters, ['A', 'B', 'C']);
	assert.ok(p.prompt.endsWith('_<|im_end|>\n'));
});

test('packed: un placeholder multi-token est refusé', async () => {
	const bad = async ( s ) => s.split('').map(( c ) => c.charCodeAt(0) ).concat(s.includes('_') ? [7] : []);
	await assert.rejects(P.buildPacked({ state: 'S', tokenize: bad, questions: [{ id: 1, question: 'q', options: ['a', 'b'] }] }),
		( e ) => e.code === 'PACKED_MISALIGNED');
});

test('packed: readPacked lit prompt_logprobs à chaque position, forme vLLM', async () => {
	const p = await P.buildPacked({ state: 'S', tokenize: charTok, questions: [
		{ id: 'q1', question: 'one', options: ['a', 'b'] }, { id: 'q2', question: 'two', options: ['x', 'y'] } ] });
	const pl = new Array(p.prompt.length).fill(null);
	pl[p.positions[0]] = { 1: { logprob: -0.1, rank: 1, decoded_token: 'A' }, 2: { logprob: -2.4, rank: 2, decoded_token: 'B' } };
	pl[p.positions[1]] = { 3: { logprob: -0.7, rank: 1, decoded_token: ' B' }, 4: { logprob: -0.7, rank: 2, decoded_token: 'A' } };
	const rows = P.readPacked({ choices: [{ prompt_logprobs: pl }] }, p, { theta: 0.5 });
	assert.equal(rows[0].choice, 'a');
	assert.equal(rows[0].id, 'q1');
	assert.equal(rows[1].undecided, true);                                      // marge 0 < 0,5
	assert.ok(rows[1].spacedMass > 0);
});

test('packed: prompt_logprobs absent = refus typé, pas l\'uniforme', async () => {
	const p = await P.buildPacked({ state: 'S', tokenize: charTok, questions: [{ id: 1, question: 'q', options: ['a', 'b'] }] });
	assert.throws(() => P.readPacked({ choices: [{}] }, p), ( e ) => e.code === 'PROMPT_LOGPROBS_ABSENT');
});

test('packed: le rejeu de la campagne (coordonnées, 27B) redonne 0,911', () => {
	// la fixture porte déjà les distributions par question ; on re-décide et on compare à l'oracle
	let n = 0, ok = 0;
	for ( const obj of fix.results ) for ( const r of obj.rows ) {
		if ( !r.probabilities ) continue;
		const d = require('../lib/readout').decide({ probabilities: r.probabilities, options: r.poles, theta: 0 });
		n++; if ( d.top === r.oracle ) ok++;
	}
	assert.equal(n, 90);
	assert.ok(Math.abs(ok / n - 0.911) < 0.006, 'accord ' + (ok / n));
});

test('packed: divergence separate ↔ packed compte les verdicts qui diffèrent, par bande', () => {
	const a = [{ id: 1, top: 'x', band: 'certain' }, { id: 2, top: 'y', band: 'med' }];
	const b = [{ id: 1, top: 'x', band: 'certain' }, { id: 2, top: 'z', band: 'med' }];
	const d = P.divergence(a, b);
	assert.equal(d.n, 2); assert.equal(d.differ, 1); assert.equal(d.rate, 0.5);
	assert.equal(d.byBand.med.differ, 1); assert.equal(d.byBand.certain.differ, 0);
});

// 21/09, mesuré en vol : le cœur prend la racine du serveur (sans /v1) et le client packed exigeait « /v1 » —
// la même valeur passée aux deux donnait `/v1/v1/completions` → 404. Les deux formes rendent la même URL.
test('createPackedClient — baseUrl avec ou sans /v1 rend la même URL de completions (fix 21/09)', async () => {
  const seen = [];
  const fetch = async ( url ) => { seen.push(url); return { ok: false, status: 599, json: async () => ({}) }; };
  const tokenize = async ( s ) => [...s].map(( c ) => c.charCodeAt(0) );
  for ( const baseUrl of ['http://h:8000', 'http://h:8000/', 'http://h:8000/v1', 'http://h:8000/v1/'] ) {
    const pk = createPackedClient({ baseUrl, model: 'm', tokenize, fetch });
    await assert.rejects(() => pk.decidePacked('s', [{ id: 'q', question: 'q', options: ['X', 'Y'] }]), /NOTJEV_HTTP/);
  }
  assert.deepStrictEqual([...new Set(seen)], ['http://h:8000/v1/completions'], 'une seule URL quelle que soit la forme');
});
