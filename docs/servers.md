# Serving it, and the engines it runs on

## As a service

```bash
notjev serve --port 8787 &
until curl -sf localhost:8787/health >/dev/null; do sleep 0.2; done

curl -s localhost:8787/v1/decide -H 'content-type: application/json' -d '{
  "state": "The minister announced a plan on Tuesday.\n",
  "theta": 0.5,
  "questions": [
    { "id": "kind",   "question": "event type",          "options": ["ANNOUNCE", "MEET", "VOTE"] },
    { "id": "policy", "question": "is this about policy?", "noul": { "yes": "YES", "no": "NO" } },
    { "id": "depth",  "question": "how concrete is it?",   "score": 5 }
  ]
}'

kill %1
```

One state, N questions, typed answers — the native route: it claims compatibility with nothing.

`NOTJEV_API_KEY` (or `--api-key`), when set, turns the POST routes into bearer-guarded ones (Jev's
`401` shape): one key, two doors (upstream, callers).

## The Jev wire contract — `POST /v1/systemone`

The same server also speaks the one-endpoint contract of TypeSafe's Jev and of the OpenJev
ecosystem, so a `typesafe-sdk` (or anything that speaks it) pointed at this server works unchanged —
against ANY OpenAI-compatible engine you configure:

```bash
notjev serve --port 8788 &        # same process: /v1/decide AND /v1/systemone
until curl -sf localhost:8788/health >/dev/null; do sleep 0.2; done

curl -s localhost:8788/v1/systemone -H 'content-type: application/json' -d '{
  "state": "The minister announced a plan on Tuesday.",
  "questions": {
    "policy": { "type": "noul",   "instructions": "is this about policy?" },
    "kind":   { "type": "choice", "instructions": "event type",
                 "criteria": { "ANNOUNCE": "someone makes something public",
                               "MEET": "two parties meet", "VOTE": "a ballot is held" } }
  }
}'

kill %1
```

Answers come back grouped as `{ nouls, choices, scores }` with `confidence = 1 − H(p)/ln K`, `usage`
in Jev field names, `GET /v1/models` resolving `jev-latest`, and FastAPI-shaped `422` detail lists.
Every answer also carries a `notjev` block — `margin`, `band`, `coverage`, `degraded` — the
instrument fields the contract has no room for. Two things are REFUSED rather than degraded: a
choice with more than 26 options (the letter regime; Jev allows 255) comes back `422` with a named
reason, never a truncated menu; and an upstream failure is a `502` for the whole request, never
half-filled answers.

## Server quickstarts

**vLLM** — logprobs are on by default; a thinking model needs the template switch, which this
library sends by default (`chat_template_kwargs: {enable_thinking: false}`).

```sh
vllm serve <model> --max-model-len 32768 --max-num-seqs 4
export NOTJEV_BASE_URL=http://127.0.0.1:8000 NOTJEV_MODEL=<model>
```

**llama.cpp** — `llama-server` returns chat logprobs since PR #10783; check your build. The
`llama-server` backend (`/completion` + `n_probs`) renders the same ChatML string byte for byte and
reads `completion_probabilities`:

```sh
llama-server -m model.gguf --port 8080
# in code: createLlamaServerClient({ baseUrl: 'http://127.0.0.1:8080', nProbs: 40 })
```

**Ollama** — logprobs on `/v1/chat/completions` landed in 0.12.11; older versions silently return
none, which this library reports as `degraded: true` rather than as a hesitation. The
OpenAI-compatible layer does not accept the thinking switch, so point at an instruct model
(e.g. `qwen3:4b-instruct-2507`), not a thinking one.

```sh
export NOTJEV_BASE_URL=http://127.0.0.1:11434 NOTJEV_MODEL=qwen3:8b
```

**OpenAI** — remove the template switch, it rejects unknown body fields:

```sh
export NOTJEV_BASE_URL=https://api.openai.com NOTJEV_MODEL=gpt-4.1-mini NOTJEV_API_KEY=sk-…
notjev decide --no-template-kwargs --state 'x' --question q --option A1 --option B1
```

(in code: `createClient({ templateKwargs: null })`; some models also want
`extra: { max_completion_tokens: 1 }` instead of `max_tokens`.)
