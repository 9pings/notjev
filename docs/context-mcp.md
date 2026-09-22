# Context, MCP and the gateway

The core reads one `state`. The modules below extend the same readout to a CONVERSATION: an explicit
context (text, tool history, even images), an immutable snapshot store, a decision service that is
independent of any transport, an MCP server with three tools, and an optional gateway that binds
"the current conversation" to THE request that carried the tool call. Nothing here changes how a
decision is read: same one-token `logprobs` readout, same `coverage`, same `theta` abstention.

## The decision service — one place, any transport

```js
const { createDecisionService, createHttpContextBackend } = require('notjev');

const service = createDecisionService({
	backend: createHttpContextBackend({ baseUrl: 'http://127.0.0.1:8000', model: 'qwen27b' }),
});
const { ref } = service.putContext({ type: 'messages',
	messages: [{ role: 'user', content: 'The secret code word is ORANGE.' }] });

const batch = await service.decide({
	context: { type: 'snapshot', ref },
	questions: [{ id: 'code', question: 'the secret code word', options: ['ORANGE', 'BLUE'] }],
});
// { contextRef: 'ctx_…', model: 'qwen27b', results: [{ id: 'code', status: 'decided', choice: 'ORANGE', … }] }

await service.close();   // aborts in-flight work, waits for it, then releases the backend
```

A context is `fresh` (`state` text, or `messages`), explicit `messages`, or a `snapshot` `ref` —
no context at all means an empty fresh one. Every batch is validated BEFORE any inference (a
malformed batch costs nothing), question IDs are unique, the whole batch shares ONE frozen context,
and a failing line becomes `{ status: 'error', error: { code } }` instead of failing its neighbours.
`execution` is `'independent'` only: each question re-reads the same context, no answer feeds the
next. Concurrency, timeout and a caller `signal` are bounded per batch.

## The store — snapshots, not sessions

`putContext` stores an immutable JSON snapshot under a UUID reference, with a scope, a TTL (15 min
default), and quotas (128 entries, 64 MiB by default — exceeded is `NOTJEV_CONTEXT_LIMIT`, never a
silent eviction). Readers take a LEASE: a snapshot being read is not swept out from under them.
Scopes isolate callers — one scope cannot resolve another scope's references. There is no notion of
"the last session": every decision correlates to the snapshot it names, or to the request that
carried it through the gateway.

Message normalization preserves roles and multimodal parts VERBATIM (text, and `image_url` over
HTTP or a data URL), and validates complete tool exchanges — a `tool_calls` message must meet its
`tool` results, in order, with no duplicates and no orphans.

## The two backends

| backend | what it does | what it refuses |
|---|---|---|
| HTTP (`createHttpContextBackend`) | preserves the context's messages, appends the question turn, `max_tokens: 1`, `logprobs`, no streaming; context tools ride along with `tool_choice: none`; reports the engine's cached tokens | a snapshot whose `model` differs from the configured one |
| native (`createNativeContextBackend`) | one resident GGUF via `node-llama-cpp`, one exclusively queued sequence, prefix reuse through `adaptStateToTokens` + checkpoints, raw probabilities | images (`NOTJEV_NATIVE_VISION_UNSUPPORTED`), tool histories (`NOTJEV_NATIVE_CONTEXT_UNSUPPORTED`), thinking-on templates |

The native backend renders the thinking-off ChatML itself, byte for byte the core's envelope: the
model's embedded Jinja template cuts the assistant turn at the thought block, and the readout then
sits on reasoning tokens — the letters get a sliver of mass and the verdict looks decided while
being noise. That failure was observed in vivo (2026-09-22), which is why the render is explicit.
Prefix reuse is reported, not promised: `cache: { cachedTokens, checkpoint }` says what was
reused; a cold read is a cold read.

## MCP — three tools, stdio

```sh
notjev mcp --base-url http://127.0.0.1:8000 --model qwen27b
notjev mcp --model-path /path/model.gguf --gpu cuda --require-gpu
notjev mcp --service-url http://127.0.0.1:8789     # reuse a running gateway
```

`notjev_decide` (a batch of the three question forms), `notjev_context_put`, `notjev_context_drop`.
The host CLI keeps the conversation and the tool loop — NotJev only judges. The MCP server can name a
context explicitly (`fresh`, `messages`, `snapshot`) but cannot read the host's history: MCP has no
such access, and `current` is refused by the service (`NOTJEV_BAD_CONTEXT`) unless the gateway
replaced it first. The SDK is an optional peer: without it the refusal is `NOTJEV_MCP_MISSING`,
named, not a crash. Install it explicitly alongside the package:
`npm install notjev @modelcontextprotocol/sdk`. The native command likewise needs the optional
`node-llama-cpp` peer.

## The gateway — `current` becomes THE request

```sh
notjev gateway --base-url http://127.0.0.1:8000 --model qwen27b --port 8789
```

The gateway is an OpenAI-compatible Chat Completions proxy PLUS control routes
(`/notjev/decide`, `/notjev/context/put`, `/notjev/context/drop`, and a free `/health`). It exists
for one reason: a CLI tool call saying `{ context: { type: 'current' } }` has no way to attach the
conversation — so the gateway captures THE request that produced the call, stores it as a snapshot,
and rewrites exactly that argument to `{ type: 'snapshot', ref }`. The rest of the arguments, the
other tool calls, and every other field of the request pass through VERBATIM; `fresh` and `snapshot`
contexts are never rewritten. Two identical requests get two captures — a binding is never shared.
`--tool-name` matches a CLI-prefixed name (`cli_notjev_decide`).

In streaming, tool-call fragments (split names, split arguments, Unicode) are buffered for ALL
tools until `finish_reason`, the ordinary text streams through live, and the assembled calls are
re-emitted once — bound if they are NotJev's, verbatim otherwise. A stream cut in the middle of a
tool call is an ERROR (the connection dies), never a silently amputated call; a stream that ends
with unfinished calls, or sends data after the terminal event, is refused the same way. Body sizes
are bounded on every entrance.

Honest limits: buffering all tools' fragments is broader than "only NotJev calls" — it costs
latency on every streamed tool call. Compatibility with a real CLI's enriched arguments is
exercised by the unit suite against a fake upstream, not demonstrated against a specific CLI.

One measured trap (2026-09-22, Qwen on llama-server): deciding on a snapshot captured from a
request that CARRIED tools can collapse the coverage — `tool_choice: 'none'` is not honoured by
every template, the model opens a tool call instead (the top token was `<tool_call`, 96 % of the
mass) and the menu letters keep a sliver (coverage 0.0004) that renormalises into a confident
verdict. `coverage` is the honest signal in that regime: read it before trusting a verdict made
over a tools-carrying capture. The readout's renormalisation policy is historical and is not
changed silently to hide this.

## What was actually run (2026-09-22)

One RTX 5090, one model (Qwen3.8-27B NVFP4). Text: the 4-run A→B→A smoke plus concurrency, per
backend (raws: `bench/results/context-*-2026-09-22.json`). Vision: three labelled sets through
the same published path — MNIST handwriting (150), CIFAR-10 real colour photos (150), and 100
rendered text/screenshot panels — numbers and what they do NOT say in
[docs/measurements.md](measurements.md). The native backend refuses images explicitly
(`NOTJEV_NATIVE_VISION_UNSUPPORTED`), and that refusal is tested, not assumed.
