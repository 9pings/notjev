# The modules

The core reads one question at a time, over HTTP, against a chat endpoint. Seven modules sit around
it, each one paid for by a measurement of the 2026-09-20/21 campaign. They all speak the same shape
— `entries = [{token, logprob}]` per position read, then `distribution`, then `decide` — and none
of them renormalises anything in silence.

| module | what it adds | the number behind it |
|---|---|---|
| `packed` | several questions on ONE state, in one pass | 0.911 agreement vs 0.900 read one by one, ~2.2x cheaper |
| `backends/llama-server` | GGUF via `/completion` + `n_probs` | same prompt byte for byte as vLLM; 0.935 vs 0.947 |
| `backends/node-llama-cpp` | native Node readout, packed by positions, no server | `controlledEvaluate` marks arbitrary positions |
| `tokenizer` | the instrument checks, before any number | 17 IPTC codes share their first token — that regime is REFUSED |
| `calibration` | temperature fitted on a declared split | ECE 0.121 -> 0.051 (8B), 0.035 -> 0.017 (27B) |
| `harness` | permutation, A/B swap, strata, null arms, flips | 17.7 % of verdicts flip when the menu is reshuffled |
| `set` | a coordinate as a SET of active nodes | exact-set 0.692 / Jaccard 0.817, against a null arm at 0.291 |
| `logits` | entries straight from pruned logits | `lse` missing -> `coverage: null`, never 1 |
| `contract` | the JSONL form the scorer reads | a missing field refuses BEFORE the GPU is spent |
| `wire` | the Jev `/v1/systemone` contract, translated | a `typesafe-sdk` works unchanged; >26 options = `422`, never truncated |
| `context` + `service` + `gateway` + `mcp` | a CONVERSATION as context: snapshots, three MCP tools, `current` bound to its request — [docs/context-mcp.md](context-mcp.md) | abstention removes 24/27 vision errors (MNIST) and 55/59 (CIFAR-10), theta = 0.5 |

**Packed** — one state, k questions, one forward pass. The prompt is a chain of alternating turns
whose assistant turns carry a fixed placeholder (`_`, never the model's own answer); the
distribution that predicted that placeholder IS the answer to the question above it. The positions
are located by incremental tokenisation and then **verified**: a misalignment refuses
(`PACKED_MISALIGNED`) rather than returning a perfectly plausible, perfectly wrong distribution.

```js
const { packed } = require('notjev');

// In production, inject the server's tokenizer:
//   const tokenize = require('notjev/tokenizer').makeHttpTokenizer({ baseUrl, kind: 'llama-server' });
// Here, a toy one (1 char = 1 token) so this example runs with no server at all.
const tokenize = async (s) => [...s].map((c) => c.charCodeAt(0));

(async () => {
  const p = await packed.buildPacked({
    state: 'Nikon FM2 — 1982, manual focus, mechanical shutter to 1/4000.',
    tokenize,
    questions: [
      { id: 'focus', question: 'focusing', options: ['manual', 'autofocus'] },
      { id: 'meter', question: 'metering', options: ['none', 'centre-weighted', 'matrix'] },
    ],
  });
  console.log(p.positions.length, 'slots,', p.nTokens, 'tokens, one state written once');
  // Then: POST /v1/completions with { prompt: p.prompt, max_tokens: 1, prompt_logprobs: 20 }
  // and packed.readPacked(resp, p) gives one decision per question.
})();
```

**Calibration** — a temperature is fitted on a CALIB split and published with it. Applying a `T`
fitted elsewhere is a transfer, and says so (`split`).

```js
const { calibration } = require('notjev');

// 100 readouts that all said 0.95, right 70 times: over-confident.
const rows = [];
for (let i = 0; i < 100; i++) rows.push({ probabilities: [0.95, 0.05], label: i < 70 ? 0 : 1 });

const fit = calibration.fitTemperature(rows, { split: 'calib-2026-09' });
console.log('T', fit.T.toFixed(2), 'ECE', fit.eceBefore.toFixed(3), '->', fit.eceAfter.toFixed(3), 'split', fit.split);
```

**Harness** — nothing is published without a null arm on the same measurand, and every perturbation
is seeded, therefore replayable.

```js
const { harness } = require('notjev');

const a = [{ id: 1, top: 'x' }, { id: 2, top: 'y' }, { id: 3, top: 'z' }];
const b = [{ id: 1, top: 'x' }, { id: 2, top: 'q' }, { id: 3, top: 'z' }];
console.log('flips', harness.flips(a, b));                 // { n: 3, flips: 1, rate: 0.333... }

const perm = harness.permute({ question: 'which one', options: ['x', 'y', 'z'] }, 7);
console.log('menu reshuffled', perm.question.options, 'order', perm.order);
```

**Set** — a coordinate is a SET of active nodes: one Choice per division, plus a Noul asking whether
the division applies at all. The band is a **reliability cursor per node**, never what constitutes
the set: tightening to `p1 >= 0.9` raised per-node precision to 0.90 and dropped the exact-set from
0.692 to 0.565. So a cursor REMOVES nodes (into `undecided`), it never adds any.

```js
const { set } = require('notjev');

const r = set.readSet({ divisions: [
  { id: 'focusing',  poles: ['manual', 'autofocus'],        probabilities: [0.97, 0.03] },
  { id: 'metering',  poles: ['none', 'centre', 'matrix'],   probabilities: [0.10, 0.52, 0.38] },
  { id: 'flash',     poles: ['none', 'built-in'],           probabilities: [0.80, 0.20], applies: 0.2 },
] });
console.log('active', r.active.map((n) => n.node + ' (' + n.band + ')'));
console.log('skipped', r.skipped.map((s) => s.division));   // the Noul said the division does not apply
```

## The JSONL contract

Three implementations already run on this measurand (this library, a Python pruning probe, the
campaign clones). What makes them comparable is not their code, it is one line shape — validated by
`notjev/contract`, which refuses **before** the GPU is spent rather than at scoring time.

An INPUT line carries `{ id, kind, options }` plus **either** `{ state, question }` (the library
renders the string) **or** `content` — the string already rendered, taken byte for byte. That second
door exists for probes that must replay their own recorded prompt exactly.

An OUTPUT line carries `id, choice, p1, p2, margin, band, prior, coverage, exactMass, spacedMass,
degraded, undecided, theta, probabilities`, and optionally `value`, `expectation`, `prompt_sha256`,
`backend`, `model`, `source` (`'http'` or `'logits'`) and `layer`. **`coverage` must be present**, and
`null` is a legal value: it says "this path cannot compute it" (pruned logits with no `lse`). Absent,
it would read as "all was well"; written as `1`, it would claim nothing was said outside the menu.

```js
const { contract, readResponse } = require('notjev');

contract.validateInput({ id: 'q1', kind: 'choice', state: 'A vs B', question: 'verdict',
  options: ['SAME', 'OTHER'] });

const resp = { choices: [{ logprobs: { content: [{ token: 'A', logprob: -0.05,
  top_logprobs: [{ token: 'A', logprob: -0.05 }, { token: 'B', logprob: -3.5 }] }] } }] };
const row = Object.assign({ id: 'q1' }, readResponse(resp, { options: ['SAME', 'OTHER'], theta: 0.5 }), {
  prompt_sha256: contract.sha256('the exact prompt that was sent'),
  backend: 'vllm', model: 'my-model', source: 'http',
});
contract.validateOutput(row);
console.log('contract ok —', row.choice, row.band, 'coverage', row.coverage.toFixed(4));
```
