<h1 align="center">NotJev</h1>

---

<p align="center">
  <a href="https://www.npmjs.com/package/notjev">
    <img src="https://img.shields.io/npm/v/notjev.svg" alt="npm version">
  </a>
  <a href="https://github.com/9pings/notjev/actions/workflows/ci.yml">
    <img src="https://github.com/9pings/notjev/actions/workflows/ci.yml/badge.svg" alt="CI">
  </a>
  <a href="https://nodejs.org/">
    <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node >= 20">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0">
  </a><br/>
<b>One token. A real probability. A decision you can trust (or refuse).</b>
</p>

---


Closed questions don’t need free-text generation.  
Present the options as `A.` `B.` `C.`…, ask for a single token with `logprobs`, keep only the letter mass, renormalise → you get a **verdict + margin + tunable abstention**.

- Works with **any** OpenAI-compatible endpoint that returns logprobs (vLLM, llama.cpp, Ollama, OpenAI…)
- Zero runtime dependencies
- Same model as your chat stack (true System 1)
- Speaks the Jev `/v1/systemone` wire contract
- 26 options max. One HTTP request. `max_tokens: 1`

You just need a model, **loaded and reachable** — and it is the *same* model as the rest of your stack, not a concession. The weights that answer your chat sessions are the weights that decide.

**notjev** is the fast **System 1** read on that model (one token, a probability).  
When the margin is too thin → escalate to the same model in full chat mode.  
The same server’s `/v1/chat/completions` becomes the **System 2** answer. Escalation is just a route change: decide first with one token, then send the uncertain cases to the same model as a normal chat.

What it costs:  
one token is one thought (no deliberation), the probabilities are ordered but not calibrated, and the raw `p1` does not survive a change of engine — the `band` does.


## Install

```sh
npm install notjev
```

Node >= 20 (native `fetch`). No dependencies.

## Quickstart

```js
const { createClient } = require('notjev');
const jev = createClient();          // NOTJEV_BASE_URL, NOTJEV_MODEL, NOTJEV_API_KEY, NOTJEV_THETA

(async () => {
  const r = await jev.decide({
    state   : 'A: "Sarah Knafo"\nB: "Sarah Knafot" (seen in an audio transcript)\n',
    question: 'verdict',
    options : ['SAME', 'OTHER'],
    theta   : 0.5,
  });
  console.log(r.choice, r.p1.toFixed(3), r.band, r.coverage.toFixed(3));
  // null 0.500 0.000 med 0.983   <- a 27B, exactly torn on this pair: no verdict at theta 0.5
  if (r.undecided) console.log(r.explain());

  const b = await jev.noul('The minister announced a plan.\n', 'is this about policy?',
    { yes: 'YES', no: 'NO' });
  console.log(b.value, b.p1.toFixed(3));                          // true 0.97

  const s = await jev.score('The minister announced a plan.\n', 'how concrete is it?', 5);
  console.log(s.value, s.expectation && s.expectation.toFixed(2));
})();
```

Three closed forms — a list (`options`), a boolean (`noul`, your two options, any language), a scale
(`score`, digits). `choice` is the code or **`null`** — null is not a fallback, it is the absence of a
verdict. `band` is `low` < 0.5 <= `med` < 0.75 <= `high` < 0.9 <= `certain`, `prior` its middle —
what is portable across engines, unlike the raw float. `coverage` is the option mass before
renormalisation: low means the model wanted to answer something else entirely, and `degraded` means
it did. Full details: [docs/question-forms.md](docs/question-forms.md).

`jev.prompt(q)` builds the exact string **without sending anything** — the first rung of every
diagnosis.

## Performance, measured

![Latency and throughput](docs/figures/perf-2026-09-22.svg)

Every arm runs the same mechanism on ITS OWN model and hardware — the engine is the variable, not
the readout. All notjev rows measured by `bench/throughput.js` (2026-09-22, raws committed):

| engine | p50 | throughput |
|---|---|---|
| llama-server `Qwen3-8B-Q4_K_M` | **23 ms** | 41.8 q/s (c1) · 52.6 q/s (c2) |
| vLLM `Qwen3.8-27B-NVFP4` | **101 ms** | 9.6 q/s (c1) · 20.3 q/s (c4) |

Hosted Jev measures at a **419 ms** median on the same style of questions; so1's headline 71.9 q/s is
a 4B on an H200. One honest inversion we measured and publish as-is: on vLLM, `packed` is slower than
reading one by one — it saves tokens, not time, on an engine with a prefix cache.

```sh
# reproduce against any llama-server or vllm instance — ~60 requests, not a load test
node bench/throughput.js --backend llama --base-url http://…:8000 --model <model> --n 16 --concs 1,2
```

## As a service — including the Jev wire contract

```bash
notjev serve --port 8787 &          # NOTJEV_API_KEY, when set, bearer-guards the POST routes
until curl -sf localhost:8787/health >/dev/null; do sleep 0.2; done

curl -s localhost:8787/v1/decide -H 'content-type: application/json' -d '{
  "state": "The minister announced a plan.\n",
  "questions": [{ "id": "kind", "question": "event type", "options": ["ANNOUNCE", "MEET", "VOTE"] }]
}'

curl -s localhost:8787/v1/systemone -H 'content-type: application/json' -d '{
  "state": "The minister announced a plan.",
  "questions": {
    "kind": { "type": "choice", "instructions": "event type",
               "criteria": { "ANNOUNCE": "someone makes something public", "MEET": "two parties meet" } }
  }
}'

kill %1
```

`/v1/decide` is the native route (every Decision field on the wire). `/v1/systemone` is the Jev wire
contract — a `typesafe-sdk` works unchanged against ANY engine you configure, answers grouped as
`{nouls, choices, scores}` with `confidence = 1 − H(p)/ln K`, FastAPI-shaped `422`s, and a `notjev`
block per answer carrying the instrument (`margin`, `band`, `coverage`, `degraded`). Engines and
details: [docs/servers.md](docs/servers.md).

## CLI

```bash
notjev decide --state 'A: "Sarah Knafo" / B: "Sarah Knafot"' --question verdict \
  --option 'SAME=one and the same entity' --option 'OTHER=two distinct entities' --theta 0.5 --json
```

`--state` takes a file, a literal, or `-` (stdin). Exit codes: **0** a verdict, **3** UNDECIDED,
**4** DEGRADED, **1** an error — a shell can tell "it said SAME" from "it said nothing". `notjev
replay run.json` re-reads a recorded run offline, no server at all. `notjev mcp` and `notjev
gateway` serve the context subsystem (see [docs/context-mcp.md](docs/context-mcp.md)).

## Use cases

* **A judge with a closed codomain** — verdict, margin, and an abstention you can price.
* **Entity anchoring / deduplication** — the margin is the product, not the verdict.
* **Grading with confidence** — `score` returns the expectation over the whole scale.
* **Measuring a prompt change** — `harness` permutes, stratifies, runs the null arms.
* **Not**: free generation, or anything whose codomain you cannot write down. One token says
  nothing there, and this library refuses to pretend otherwise.

## Documentation

* [The three question forms, and what comes back](docs/question-forms.md)
* [Measuring it on your own questions](docs/measurement.md) — record, replay, report, null arms
* [The modules](docs/modules.md) — packed, tokenizer checks, calibration, harness, set, contract, wire
* [Serving it, and the engines](docs/servers.md) — /v1/decide, /v1/systemone, vLLM, llama.cpp, Ollama, OpenAI
* [Context, MCP and the gateway](docs/context-mcp.md) — snapshots, the decision service, the 3 MCP tools, `current` binding
* [What is measured, and where](docs/measurements.md) — provenance, against the null arms and the clones
* [Limits, and the decisions behind them](docs/internals.md)

## En français, en bref

La lecture de décision : on présente les options `A.`, `B.`, …, on demande **un** token avec
`logprobs`, on garde la masse des lettres, on renormalise. On obtient un verdict **et** une
probabilité, donc une marge (`p1 - p2`), donc une abstention réglable (`theta`) — et un `coverage`
qui dit quand le modèle voulait répondre autre chose. `UNDECIDED` n'écrit rien : la question reste
pendante et se re-pose quand l'état change. Le point `p1` n'est pas portable d'un moteur à l'autre,
la **bande** l'est : on range `p1` dans `low/med/high/certain` et on écrit le milieu de bande
(`prior`). Aucune liste de mots d'une langue ne vit dans la bibliothèque : les options, leurs
descriptions et la question viennent de l'appelant, toujours — `noul()` prend donc ses deux options
en argument.

## Tests

![The suite](docs/figures/tests-2026-09-22.svg)

```sh
npm test      # node --test: the pure reading, the client against a real socket, the CLI, the README
npm run lint  # node --check on every file
```

CI runs lint + tests on Node 20 and 22; `npm publish` re-runs them through `prepublishOnly`. Every
negative control in the suite is **named** — it states which sabotage it detects. A green suite that
cannot fail proves nothing.
