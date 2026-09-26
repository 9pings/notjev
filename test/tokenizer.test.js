'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../lib/tokenizer');

// un tokenizer factice : 1 caractère = 1 id, sauf "medtop:" qui est UN token (id 999) — le piège IPTC
const fake = async ( s ) => { const out = []; for ( let i = 0; i < s.length; i++ ) {
	if ( s.startsWith('medtop:', i) ) { out.push(999); i += 6; } else out.push(s.charCodeAt(i)); } return out; };

test('tokenizer: chaque lettre = un token, ids distincts', async () => {
	const r = await T.checkLetters(fake, ['A', 'B', 'C']);
	assert.deepEqual(r.ids, [65, 66, 67]);
});
test('tokenizer: une lettre multi-token est refusée par son code', async () => {
	// le libellé 'AB' tokenise en DEUX tokens : c'est le cas que le contrôle doit refuser (le plan
	// écrivait `[1]`, soit un token unique — le fake ne déclenchait alors rien à refuser).
	const glue = async ( s ) => s === 'AB' ? [1, 2] : s.split('').map(( c ) => c.charCodeAt(0) );
	await assert.rejects(T.checkLetters(glue, ['AB']), ( e ) => e.code === 'LETTER_NOT_ATOMIC');
});
test('tokenizer: deux lettres qui partagent un id sont refusées', async () => {
	const collide = async () => [ 7 ];                      // tout tokenise sur le même id
	await assert.rejects(T.checkLetters(collide, ['A', 'B']), ( e ) => e.code === 'LETTER_NOT_ATOMIC');
});
test('tokenizer: la frontière de réponse tient (prompt+lettre = prompt ++ [id])', async () => {
	const r = await T.checkBoundary(fake, 'Question:\nA. x\n', 'A');
	assert.equal(r.id, 65);
});
test('tokenizer: une frontière qui recolle est refusée', async () => {
	const merge = async ( s ) => s.endsWith('\nA') ? [1, 2] : s.split('').map(( c ) => c.charCodeAt(0) );
	await assert.rejects(T.checkBoundary(merge, 'x\n', 'A'), ( e ) => e.code === 'ANSWER_BOUNDARY');
});
test('tokenizer: le régime code direct est refusé quand deux codes partagent le premier token', async () => {
	const r = await T.firstTokenCollision(fake, ['medtop:01', 'medtop:02', 'X']);
	assert.equal(r.ok, false);
	assert.deepEqual(r.collisions, [['medtop:01', 'medtop:02']]);
	await assert.rejects(T.firstTokenCollision(fake, ['medtop:01', 'medtop:02'], { strict: true }),
		( e ) => e.code === 'FIRST_TOKEN_COLLISION');
});
test('tokenizer: l\'inventaire des trois régimes de la forme espacée', async () => {
	/* Trois familles de vocabulaires, telles que mesurées sur le Hub (A..S) — le contrôle classe,
	 * il ne devine pas : c'est la pièce détokenisée du SERVEUR qui choisit le seau dans `distribution`. */
	const sp = async ( s ) => [s.charCodeAt(s.length - 1)];                 // SentencePiece : " A" EST "A"
	const gpt = async ( s ) => [s.charCodeAt(0) * 1000 + s.charCodeAt(s.length - 1)]; // Ġ-BPE : 2 tokens d'ID
	const phi = async ( s ) => s === ' A' ? [32, 65] : [65];               // Phi-3 : espace nu puis lettre
	const rSp = await T.checkSpacedLetters(sp, ['A', 'B']);
	assert.deepEqual(rSp.forms.map(( f ) => f.regime ), ['same', 'same'],
		'régime `same` : spacedMass est un zéro STRUCTUREL, pas un petit nombre');
	const rGpt = await T.checkSpacedLetters(gpt, ['A', 'B']);
	assert.deepEqual(rGpt.forms.map(( f ) => f.regime ), ['single', 'single'],
		'régime `single` : spacedMass est une quantité réelle');
	assert.equal(rGpt.counts.single, 2);
	const rPhi = await T.checkSpacedLetters(phi, ['A']);
	assert.equal(rPhi.forms[0].regime, 'multi');
	assert.equal(rPhi.counts.multi, 1);
});
test('tokenizer: NEGATIVE CONTROL — la forme espacée multi-token est refusée en strict', async () => {
	/* À max_tokens: 1, un modèle qui préfère la forme espacée émet l'ESPACE : les lettres ne portent
	 * rien et la couverture sous-compte sa préférence — ce sabbotage-là, le contrôle le détecte. */
	const phi = async ( s ) => s === ' A' ? [32, 65] : [65];
	await assert.rejects(T.checkSpacedLetters(phi, ['A', 'B'], { strict: true }),
		( e ) => e.code === 'LETTER_SPACED_FRAGMENT');
});
test('tokenizer: makeHttpTokenizer parle aux deux serveurs', async () => {
	const calls = [];
	// Le faux serveur répond selon le CORPS, pas selon l'URL : les deux implémentations visent le même
	// chemin `/tokenize` (vérifié contre le vLLM réel), donc l'URL ne peut pas les distinguer. C'est le
	// corps qui porte le dialecte — `content` pour llama-server, `prompt`+`model` pour vLLM.
	const fetchFake = async ( url, init ) => { const body = JSON.parse(init.body); calls.push({ url, body });
		return { ok: true, json: async () => (body.content !== undefined ? { tokens: [1, 2] } : { tokens: [3, 4], count: 2 }) }; };
	const llama = T.makeHttpTokenizer({ baseUrl: 'http://h:8080', kind: 'llama-server', fetch: fetchFake });
	assert.deepEqual(await llama('ab'), [1, 2]);
	assert.equal(calls[0].url, 'http://h:8080/tokenize');
	assert.deepEqual(calls[0].body, { content: 'ab', add_special: false, with_pieces: false });
	const vllm = T.makeHttpTokenizer({ baseUrl: 'http://h:8000/v1', kind: 'vllm', model: 'm', fetch: fetchFake });
	assert.deepEqual(await vllm('ab'), [3, 4]);
	assert.equal(calls[1].url, 'http://h:8000/tokenize');
	assert.deepEqual(calls[1].body, { model: 'm', prompt: 'ab', add_special_tokens: false });
});
