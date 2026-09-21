'use strict';
/**
 * node-llama-cpp : LE READOUT NATIF NODE (0 Python, 0 serveur).
 *
 * `controlledEvaluate` rend les probabilités à des positions d'entrée ARBITRAIRES : le mode packed
 * y est natif, sans `prompt_logprobs` ni serveur. Porté du prototype de campagne
 * `WIP/experiments/2026-09-20-system-one-clones/scripts/maison-readout.mjs`.
 *
 * TROIS PIÈGES, tous payés une fois, tous instrumentés ici :
 *
 * 1. **« marquer i−1 lit i »** — marquer l'index `i` rend la distribution du token SUIVANT. Pour lire
 *    le token en position `p` (le placeholder d'un slot packed), on marque `p − 1` et on lit
 *    `out[p − 1].next`. Un readout classique marque donc le DERNIER token du prompt.
 * 2. **L'échantillonnage** — les défauts de la lib sont `temperature: 0, topK: 40, topP: 0.95`, et
 *    la carte rendue est POST-transformation : sans `RAW_SAMPLING` on lit une distribution tronquée,
 *    parfois un one-hot, et la « confiance » mesurée est celle du sampler, pas celle du modèle.
 * 3. **Les tokens spéciaux** — le prompt packed porte `<|im_start|>` : il se tokenise avec
 *    `specialTokens: true`, sinon les marqueurs partent en texte littéral et TOUTES les positions
 *    glissent (le prototype le fait aussi : `model.tokenize(job.prompt, true)`).
 *
 * Et un garde-fou : sur cette machine (RTX 5090 / WSL2) le prébuilt choisit Vulkan et charge 0 couche
 * — un run CPU déguisé en run GPU. `guardVram` compare la VRAM avant/après `loadModel` et refuse.
 *
 * Le module est chargé PARESSEUSEMENT et par `import()` : `node-llama-cpp` v3 est ESM pur (un
 * `require` lèverait `ERR_REQUIRE_ESM`), et c'est une peer OPTIONNELLE — notJev reste à zéro
 * dépendance runtime.
 */
const readout = require('../readout');
const chatml = require('../chatml');
const { formOf, readResponse } = require('../client');
const { fail } = require('../errors');
const { buildPacked } = require('../packed');

/** L'échantillonnage BRUT : le softmax du modèle, pas celui du sampler. */
const RAW_SAMPLING = { temperature: 1, topK: 0, topP: 1, minP: 0, seed: 0 };

/**
 * `Map<tokenId, prob>` → `entries = [{ token, logprob, id }]`, triées par probabilité décroissante.
 *
 * @param probMap la carte rendue par `next.probabilities` (triée décroissante, vocabulaire ENTIER).
 * @param decode `(id) => string` — coûteux : il n'est appelé que sur les entries retenues.
 * @param o `{ limit=64, keep=[] }` — `limit` borne le top retenu, `keep` force des ids (les lettres,
 *          et leurs variantes espacées) même s'ils tombent hors du top : sinon une lettre rare
 *          sortirait à masse nulle et `coverage` mentirait vers le bas.
 */
function probsToEntries( probMap, decode, o ) {
	const limit = (o && o.limit !== undefined) ? o.limit : 64;
	const keep = new Set((o && o.keep) || []);
	const out = [];
	const taken = new Set();
	let i = 0;
	for ( const [id, p] of probMap ) {
		const wanted = (i < limit) || keep.has(id);
		i++;
		if ( !wanted || taken.has(id) ) continue;
		if ( !(p > 0) && !keep.has(id) ) continue;
		taken.add(id);
		out.push({ token: String(decode(id)), logprob: Math.log(Math.max(Number(p), 1e-300)), id });
	}
	out.sort(( a, b ) => b.logprob - a.logprob );
	return out;
}

/** GPU exigé mais rien en VRAM = run CPU déguisé : on refuse, on ne publie pas un chiffre « GPU ». */
function guardVram( o ) {
	if ( o && o.requireGpu && (!(o.after - o.before > 0) || !(o.gpuLayers > 0)) )
		throw fail('SILENT_CPU_RUN', 'SILENT_CPU_RUN — node-llama-cpp: GPU exigé mais le modèle n\'est pas '
			+ 'en VRAM (delta ' + (o.after - o.before) + ' o, ' + o.gpuLayers + ' couche(s)) — ce serait un run '
			+ 'CPU déguisé en run GPU.', { delta: o.after - o.before, gpuLayers: o.gpuLayers });
}

/** `import()` paresseux : ESM pur, peer optionnelle. Absent → un code, jamais une stack de resolver. */
async function loadModule() {
	try {
		return await import('node-llama-cpp');
	} catch ( e ) {
		throw fail('NODE_LLAMA_CPP_MISSING', 'NODE_LLAMA_CPP_MISSING — node-llama-cpp n\'est pas installé '
			+ '(peer optionnelle) : `npm i node-llama-cpp`.', { cause: e && e.message });
	}
}

/**
 * @param o `{ modelPath, gpu=false, contextSize=4096, requireGpu=false, theta?, edges?, placeholder?, topK? }`
 * @returns `{ decide, decideMany, decidePacked, prompt, tokenize, close, RAW_SAMPLING }`
 */
async function createNodeLlamaClient( o ) {
	const nlc = await loadModule();
	const gpu = (o && o.gpu) === undefined ? false : o.gpu;
	const llama = await nlc.getLlama({ gpu });
	const before = gpu ? (await llama.getVramState()).used : 0;
	const model = await llama.loadModel({ modelPath: o.modelPath, gpuLayers: gpu ? 'max' : 0 });
	const after = gpu ? (await llama.getVramState()).used : 0;
	guardVram({ requireGpu: !!(o && o.requireGpu), before, after, gpuLayers: gpu ? (model.gpuLayers || 0) : 0 });
	const context = await model.createContext({ contextSize: (o && o.contextSize) || 4096, sequences: 1 });
	const seq = context.getSequence();
	const topK = (o && o.topK !== undefined) ? o.topK : 64;

	const decodeTok = ( id ) => model.detokenize([id]);
	/* specialTokens: true — le prompt porte les marqueurs ChatML (piège 3). */
	const tokenize = async ( text ) => Array.from(model.tokenize(String(text), true));
	/** Les ids des lettres ET de leurs variantes espacées : `keep` de `probsToEntries`. */
	const letterIds = ( letters ) => {
		const ids = [];
		for ( const L of letters ) for ( const s of [String(L), ' ' + String(L)] ) {
			const t = model.tokenize(s, false);
			if ( t.length === 1 ) ids.push(t[0]);
		}
		return ids;
	};

	/**
	 * Les distributions AUX positions demandées. `positions[i]` = l'index du token à LIRE ; on marque
	 * `p − 1` et on lit `out[p − 1].next` (piège 1).
	 */
	async function readAt( text, positions, keep ) {
		const ids = await tokenize(text);
		const marks = new Set(positions.map(( p ) => p - 1 ));
		for ( const m of marks )
			if ( m < 0 || m >= ids.length )
				throw fail('PACKED_MISALIGNED', 'PACKED_MISALIGNED — node-llama-cpp: position de lecture '
					+ (m + 1) + ' hors du prompt (' + ids.length + ' tokens).');
		const input = ids.map(( t, i ) => marks.has(i)
			? [t, { generateNext: { probabilities: true, options: RAW_SAMPLING } }]
			: t );
		await seq.clearHistory();
		const out = await seq.controlledEvaluate(input);
		return positions.map(( p ) => {
			const cell = out[p - 1];
			if ( !cell || !cell.next || !cell.next.probabilities )
				throw fail('PACKED_MISALIGNED', 'PACKED_MISALIGNED — node-llama-cpp: aucune distribution à la '
					+ 'position ' + p + ' — ne pas scorer.');
			return probsToEntries(cell.next.probabilities, decodeTok, { limit: topK, keep });
		});
	}

	function prompt( q ) {
		const form = formOf(q);
		const content = readout.renderTurn({
			state: q.state, question: q.question, options: form.texts, instruction: q.instruction,
		});
		return { form, content, text: chatml.render([{ role: 'user', content }, { role: 'assistant', content: null }], { thinkingOff: true }) };
	}

	async function decide( q ) {
		const question = q || {};
		const p = prompt(question);
		const letters = readout.lettersOf(p.form.ids);
		const t0 = Date.now();
		const ids = await tokenize(p.text);
		const entries = (await readAt(p.text, [ids.length], letterIds(letters)))[0];
		const resp = { choices: [{ logprobs: { content: [{ token: entries[0] && entries[0].token, logprob: 0, top_logprobs: entries }] } }] };
		const d = readResponse(resp, {
			form : p.form,
			theta: question.theta !== undefined ? question.theta : (o && o.theta),
			edges: question.edges || (o && o.edges),
			prompt: p.text, ms: Date.now() - t0, model: o.modelPath,
		});
		d.backend = 'node-llama-cpp';
		d.source = 'http';
		return d;
	}

	async function decidePacked( state, questions, opts ) {
		const packed = await buildPacked({ state, questions, tokenize, placeholder: o && o.placeholder });
		const t0 = Date.now();
		const keep = [];
		for ( const s of packed.slots ) keep.push(...letterIds(s.letters));
		const per = await readAt(packed.prompt, packed.positions, keep);
		const theta = (opts && opts.theta !== undefined) ? opts.theta : (o && o.theta);
		const rows = packed.slots.map(( s, i ) => {
			const dist = readout.distribution(per[i], s.letters);
			const v = readout.decide({ probabilities: dist.probabilities, options: s.options, theta, edges: (o && o.edges) });
			const undecided = v.undecided || dist.degraded;
			return Object.assign({}, v, {
				id: s.id, question: s.question, position: packed.positions[i], ok: !dist.degraded,
				choice: undecided ? null : v.choice, index: undecided ? -1 : v.index,
				value: undecided ? null : s.form.decode(v.top), undecided,
				coverage: dist.coverage, exactMass: dist.exactMass, spacedMass: dist.spacedMass,
				degraded: dist.degraded, probabilities: dist.probabilities, mass: dist.mass,
				kind: s.form.kind, options: s.options, letters: s.letters, entries: per[i],
				topToken: per[i][0] || null, backend: 'node-llama-cpp', source: 'http',
			});
		});
		return { rows, packed, ms: Date.now() - t0, nTokens: packed.nTokens };
	}

	async function decideMany( state, questions, opts ) {
		const out = [];
		for ( const q of (questions || []) ) {
			const r = await decide(Object.assign({}, q, { state: q.state === undefined ? state : q.state }));
			r.id = q.id;
			r.question = q.question;
			out.push(r);
		}
		return out;
	}

	return {
		decide, decideMany, decidePacked, tokenize, RAW_SAMPLING,
		prompt: ( q ) => prompt(q).text,
		noul  : ( state, question, pair, more ) =>
			decide(Object.assign({}, more || {}, { state, question, noul: pair == null ? true : pair })),
		score : ( state, question, range, more ) =>
			decide(Object.assign({}, more || {}, { state, question, score: range == null ? { min: 1, max: 5 } : range })),
		info  : { gpu: gpu ? String(llama.gpu) : false, gpuLayers: model.gpuLayers, vramDelta: after - before },
		close : async () => { await context.dispose(); await model.dispose(); await llama.dispose(); },
	};
}

module.exports = { createNodeLlamaClient, probsToEntries, guardVram, RAW_SAMPLING };
