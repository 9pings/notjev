# Limits, and the decisions behind them

## Limits

* **26 options maximum.** One letter, one token. Beyond that, split the question.
* **`checkBoundary` takes the TEMPLATED prompt** (assistant turn open, `chatml.render(..., { thinkingOff: true })`), never the bare user content — on the bare content it refuses (`ANSWER_BOUNDARY`) although the real readout is fine (measured in vivo 21/09).
* **One letter must be one token** on your tokenizer. It is on every tokenizer used here, but check
  before you trust a new model family.
* **The probabilities are not calibrated.** They are *ordered*, which is enough for a margin and for
  bands; they are not a frequency until you measure the ECE on your own questions.
* **`top_logprobs` is capped** (20 on most servers). With 26 options and a flat model, the tail can
  fall outside the top-k: `coverage` tells you when that happens.
* **No native boolean.** `noul` is two options that you name; the library has no idea what "yes"
  means in any language, and that is deliberate.
* **The prompt weighs more than the engine** (0.833 vs 0.733 on layout alone, same model). Changing
  `instruction`, the option order, or adding descriptions is a new experiment, not a setting.
* **A thinking model must have thinking off**, or the first token is `ﰢ` and coverage is 0.

## What this is not

* not a classifier — there is no training, no head, no threshold learned on your data;
* not a calibrated probability service — it gives you the tools to measure your own calibration;
* not a guardrail or a judge with an opinion — the codomain, the wording and the order are yours;
* not a way to make a small model right; it is a way to know **how sure** a model is, cheaply, and
  to **not act** when it is not sure.

## Decisions taken in this implementation

Design calls that the source material did not settle, resolved here in favour of long-term
flexibility, and written down so they can be argued with:

1. **`lib/readout.js` is a faithful port** of the module that runs in that production judge
   (same constants, same layout, same refusals, same band/snap arithmetic — 8018 differential
   comparisons, 0 divergence). Only the parts tied to that host were dropped (its calibration store
   and the key helper), and the measurement helpers moved to `lib/metrics.js`.
2. **A degraded readout never decides.** `readout.decide` only knows the margin, and an empty
   distribution has margin 0 — at `theta: 0` it would return the first option. The client layer
   therefore forces `undecided` when `degraded`. `top` stays readable; the verdict does not exist.
3. **Options may carry a description** (`{ id, description }` renders `id: description`) and the
   returned `choice` is always the `id`. A description changes the prompt, hence the measurement —
   the docs say so rather than the library forbidding it.
4. **`chat_template_kwargs` is sent by default** (that is the measured body) and removed on request
   with `templateKwargs: null`, instead of being opt-in. Being faithful to the measured call is the
   default; adapting to a stricter server is one word.
5. **Metric rows are `{ p1, margin, choice, expected }`**, with `correct` derived when absent. The
   source harness used its own field names; the library keeps one language-neutral shape.
6. **`replay` and `notjev replay` ship with the library**, not as an example. Re-reading a recorded
   run offline is the main reason the reading is pure; leaving it out would have made the purity
   decorative.
7. **`prompt` / `body` are public.** Reading the exact string costs nothing and is the first rung of
   every diagnosis.
8. **Exit codes 3 and 4** for UNDECIDED and DEGRADED, so a shell cannot mistake an abstention for a
   verdict.
9. **Apache-2.0, revisable** — the owner settled the licence on 21/09; published as `notjev` on npm
   (public access), source at `github.com/9pings/notjev`.
