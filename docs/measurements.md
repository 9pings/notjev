# What is measured, and where

These numbers come from a **production judge** — a real editorial pipeline where this readout decides
entity matches, anchorings and event types on live traffic (170k recorded calls, 5 089 distinct
questions), campaign of **2026-09-20**, 27B model served by vLLM (NVFP4) and by llama.cpp (GGUF), on
that pipeline's own judge questions — they are quoted here as provenance, not as a promise about
your questions:

| measurement | value |
|---|---|
| agreement with the generating (grammar-constrained) arm, n = 1224 | **0.947** (vLLM), 0.935 (GGUF) |
| null arm on the same set ("always the majority class") | 0.693 |
| raw ECE, 10 buckets | **0.090** |
| latency | **70 ms**/question (vLLM), 290 ms (GGUF) |
| flips when the two options are swapped | 6.5 % |
| verdicts that differ between engines | 2.3-10.4 % overall, **0-0.1 % at p1 >= 0.9** |
| cost of permuting the menu | 5.6 % of flips (2 options), 17.7 % (near-identical labels) |
| space variants (`" A"` vs `"A"`) | <= 0.08 % of coverage — **measured on a two-ID-token family (Ġ-BPE)**: on SentencePiece vocabs `" A"` IS `"A"` (one ID token per option) and `spacedMass` is a structural zero; on Phi-3-style vocabs the spaced form is multi-token and unreadable at `max_tokens: 1`. `tokenizer.checkSpacedLetters` inventories the regime |
| abstention at theta = 0.5 on an entity-matching bench | precision 0.927, correct abstention 0.716 |
| the same bench at theta = 0 | 100 % of new entities wrongly merged |

And one measurement made *with this library*, 2026-09-21, replaying the recorded 48-question set
(`--truth gold`) and then re-asking 3 of those questions live on a **different** vLLM instance of the
same model:

| measurement | value |
|---|---|
| replay of the recording, agreement with the human truth | 0.896 (43/48), null arm 0.563, ECE 0.065 |
| the same rows at theta = 0.5 | coverage 79.2 %, precision **100 %** (5 errors out of 5 removed) |
| live re-ask, same verdict as the recording | **3/3** |
| live re-ask, same band as the recording | **3/3** |
| live re-ask, movement of the raw `p1` | up to **0.179** |

Which is the whole argument for the band, measured twice: the verdict and the band survived a
different server, the float did not.

The exact string this library sends is fingerprinted against that campaign
(`test/fixtures/campaign-turns.json`): if one byte of the envelope moves, `npm test` fails and the
numbers above stop applying. That test is the point of the fixture.

## The letter prior — the correction layer, measured (2026-09-26)

The menu-permutation numbers above (5.6 % → 17.7 % → 36.7 % of flips, and 26.1 % on the 8B vs
6.5 % on the 27B for the A/B swap) have the shape of a prior over the LETTER TOKENS rather than over
the content — growing with the number of option IDs, shrinking with model size. That mechanism has
a name and a correction: **selection bias / token bias** (Zheng et al., ICLR 2024,
arXiv:2309.03882, PriDe). Since **2026-09-26** the library carries the layer:

- `harness.letterPrior(arms)` estimates the marginal RAW mass per letter from BALANCED permuted
  arms — label-free, on the presented frame, published with its `split` and its `tokenizer`
  (`undeclared` by default, the same discipline as a fitted `T`). Two methodological rules, both
  paid for in named tests: the orders must be BALANCED per question (at K = 2 the consecutive
  seeds of `permute` all give the same order — the content marginal would read as a letter
  prior), and the estimand is the RAW MASS, not the renormalised probabilities (the renormalised
  average is biased per-arm: a 0.8/0.2 prior reads 0.64/0.36);
- `readout.distribution(entries, letters, letterPrior)` divides it out **on the mass**, and
  `coverage` stays on the RAW mass — a per-letter division would change what coverage means;
- the applied prior is echoed on the decision (`letterPrior`), and `client`/`logits`/`packed`
  accept it in their spec.

**Measured on the CAMPAIGN'S ENGINES (2026-09-26, GPU, GPUMaster slots: llama-server
`Qwen3-8B-Q4_K_M.gguf`, vLLM `Qwen3.8-27B-NVFP4`; the 21/09 in-vivo raws reproduced to the
1e-4 on the same day).** Two question regimes, both K = 2, identity + swap per question,
leave-one-question-out correction; raws: `bench/results/letters-qwen3-8b-llama-gpu-*` and
`letters-qwen3.8-27b-vllm-*`, inputs `letters-gold-ancrage-2026-09-26.jsonl` (40 production
anchoring states, ~3 k chars, REAL teacher labels) and `letters-gold-2026-09-26.jsonl` (40 short
synthetic pairs — the bench's built-in demo regime):

| 2026-09-26, GPU, 40 questions, K = 2 | 8B · production states | 27B · production states |
|---|---|---|
| letter prior (A / B), raw mass | 0.557 / 0.443 | 0.442 / 0.559 |
| concentration `kl` (nats) | **0.0066** | **0.0069** |
| flips under menu permutation, before → after LOO | 15.0 % → 15.0 % | **7.5 % → 7.5 %** |
| decided at theta = 0.5, before → after | 79/80 → 79/80 | 60/80 → 61/80 |
| accuracy vs the real teacher labels, before → after | **92.5 %** (unchanged) | **97.5 %** (unchanged) |

| same day, GPU, the SHORT synthetic regime | 8B | 27B |
|---|---|---|
| concentration `kl` | 0.119 | 0.022 |
| flips before → after LOO | 65.0 % → 52.5 % | 22.5 % → 17.5 % |
| decided at theta = 0.5, before → after | 65/80 → 56/80 | 66/80 → 66/80 |
| accuracy vs the intended labels, before → after | 54 % → 56 % | 72 % → 74 % |

Reading the two tables:

- **Production states, K = 2: the prior is near-uniform (kl ≈ 0.007), the flips match the
  campaign's regime (7.5 % vs the published 5.6 % on the 27B), and the correction is NEUTRAL —
  nothing to divide out.** Neutral-when-uniform is the correct behaviour of the layer.
- **Short synthetic states: the prior concentrates (8B kl 0.119, flips up to 65 %) — the letter
  prior is a property of the QUESTION REGIME as much as of the model.** The bench's built-in
  questions are a demo; measure on your own states.
- **The native node-llama-cpp CPU path on this machine is not equivalent to the GPU engines**
  (verdict flips on identical prompts and weights — b36f: MEME 0.9995 GPU vs AUTRE 0.99 CPU;
  CPU raws kept as `letters-qwen3-8b-2026-09-26.json` / `letters-qwen3.8-27b-2026-09-26.json`).
  Quote its numbers as CPU-condition only.
- Accuracy: production rows against REAL teacher labels, synthetic rows against intended labels.
  The K = 2 prior is not the K = 19 prior — every number is per (model, tokenizer, menu size,
  question regime).

| 2026-09-26, GPU, Qwen3.8-27B NVFP4 (vLLM), `racine` K = 19 (30 production questions, real gold) | value |
|---|---|
| flips under menu permutation, before → after LOO | **40.0 %** (48/120) → 41.7 % |
| accuracy vs gold on the identity arm, before → after | **60.0 %** (unchanged) |
| letter prior `kl` | 0.125 (A-D carry 2-5x the mass of Q-T) |

The K = 19 row **verifies the campaign's 36.7 %** — same regime, and the accuracy matches the
campaign's own racine figure (0.643). Two caveats: at K = 19 with 5 orders per question the order
balance is approximate — part of the A-D excess of the prior may be content (14/30 golds sit in
A-D of the base menu), exact balance needs cyclic rotations; and **the LOO division buys back
nothing here** (flips 48 → 50, accuracy unchanged, decided 73 → 74) — at K = 19 the flips live in
the close top-2 (median margin 0.47), where the correction and theta compete for the same cases.

**Cross-family, same protocol (2026-09-26, GPU; Gemma-3-12B-it and Phi-4-14B, both Q4_K_M GGUF,
via llama-server — the ChatML envelope is out-of-template for both, labeled; raws
`letters-gemma3-12b-*`, `letters-phi4-14b-*`):**

| production states | Qwen3-8B Q4_K_M | Qwen3.8-27B NVFP4 | Gemma-3-12B Q4_K_M | Phi-4-14B Q4_K_M |
|---|---|---|---|---|
| p50 per question (`bench/throughput.js`, llama-server, 2026-09-26) | 23 ms (22/09) | 101 ms (22/09, vLLM) | 61 ms | **19 ms** |
| `kl`, ancrage K = 2 | 0.0066 | 0.0069 | 0.0089 | 0.0019 |
| flips before → after LOO, K = 2 | 15.0 % → 15.0 % | 7.5 % → 7.5 % | 32.5 % → 32.5 % | 27.5 % → 27.5 % |
| accuracy vs gold, K = 2 | 92.5 % | 97.5 % | 87.5 % | 90.0 % |
| `kl`, racine K = 19 | **0.646** | 0.125 | **0.512** | **0.455** |
| flips before → after LOO, K = 19 | 70.8 % → 70.8 % | 40.0 % → 41.7 % | 60.0 % → 60.0 % | **75.8 % → 57.5 %** |
| accuracy vs gold before → after, K = 19 | 30.0 % → **26.7 %** (0 fixed, 4 broken) | 60.0 % → 60.0 % | 50.0 % → **56.7 %** | 23.3 % → **36.7 %** (20 fixed, 4 broken) |

- **The letter prior concentrates with K in every family measured** — the campaign's "5.6 % →
  36.7 %" shape is family-general — and **the correction pays where the prior is concentrated AND
  the model reads content**: Phi-4 (kl 0.455, 23.3 % raw accuracy) recovers 18 points of flips
  and 13.4 points of accuracy at K = 19, Gemma (kl 0.512) 6.7 points; the Qwen 27B (kl 0.125,
  already 60 %) gains nothing; **the Qwen 8B (kl 0.646, 30 % raw accuracy) LOSES 3.3 points** —
  dividing by a concentrated prior estimate on a model whose answers barely beat chance amplifies
  the estimation noise (5 orders per question, approximate balance) instead of the signal.
- **Inventory, measured against the deployed tokenizers**: Gemma-3 is the `single` regime
  ("A" = 236776, " A" = 562 — two ID tokens), and **Phi-4 is `single` too ("A" = 32, " A" = 362,
  a Qwen-style vocab) — the `multi` regime is Phi-3, not Phi-4**.
- Same caveats as the K = 19 row above: 5 orders per question, approximate balance — part of the
  A-D excess may be content; and the ChatML envelope is Qwen-shaped, so the Gemma/Phi numbers are
  "this library's readout on those models", not their native-template behaviour. Latency raws:
  `latency-gemma3-12b-2026-09-26.json`, `latency-phi4-14b-2026-09-26.json` (the packed arm is
  REFUSED on Gemma: the `_` placeholder is not a token of its vocab — `PACKED_MISALIGNED`, a named
  refusal). The 8B/27B p50s are the committed 2026-09-22 raws (llama-server / vLLM).

Still open: K = 3..18 on production states (topics 17 is in the coord file), and the remaining
families. `bench/letters.js` runs both.


## Against the clones, on the same questions

![Accuracy on production benches](figures/accuracy-2026-09-20.svg)

An independent bench of the clones (2026-09-20) ran the same gold-labelled production questions
through each tool, human-reviewed labels. The readout 27B — the mechanism this library implements —
clears the null arm on every bench and the best clone on three of four. Clone scores quoted in the
figure come from their own runs on the same questions.

## The context subsystem, smoke-tested (2026-09-22)

A smoke, not a campaign: one RTX 5090, one model (Qwen3.8-27B NVFP4), the same 4-run A→B→A text
script plus 2 synthetic-image runs, by `bench/context-smoke.js`. Raws committed:
`bench/results/context-native-2026-09-22.json`, `bench/results/context-http-2026-09-22.json`.

| run | native (node-llama-cpp, chatml thinking-off) | HTTP (llama-server, full offload) |
|---|---|---|
| cold read, 1664-token context | ORANGE, 938 ms, 0 reused | ORANGE, 959 ms, 0 cached |
| warm re-read of the same context | ORANGE, 191 ms, **1614 tokens reused** | ORANGE, 569 ms, 0 reported |
| switch to the BLUE context | BLUE, 797 ms, 1609 reused | BLUE, 255 ms, 1148 cached |
| back to the first context | ORANGE, 794 ms, 1609 reused | ORANGE, 254 ms, 1148 cached |
| two contexts read concurrently | both correct, isolated | both correct, isolated |
| synthetic RED / BLUE image, `mmproj` | refused (`NOTJEV_NATIVE_VISION_UNSUPPORTED`) | RED and BLUE, correct, coverage 1.0 |

Every verdict was right and every coverage >= 0.99. What these numbers do NOT say: that the cache
gain generalises (the warm path is one prompt family, one engine), or that vision works beyond two
solid-colour PNGs — and the native row for vision is a REFUSAL, which is the tested behaviour.
The first native attempt failed for a reason worth recording: with the model's Jinja template the
first token belonged to the thought block, the letters carried ~1e-8 of the mass and the verdict
was still emitted, wrong. The render is now explicit (`chatml`, thinking off), and the readout
still never renormalises silently to hide such a regime.

## Vision on real labelled images (2026-09-22)

Three sets, all through the PUBLISHED path (`createDecisionService` + the HTTP context backend →
llama-server + `mmproj`, Qwen3.8-27B NVFP4, RTX 5090), scored against ground truth, `theta = 0.5`.
Reproduce with `bench/vision-mnist.js`, `bench/vision-animals.js`, `bench/vision-text.js`
(raws: `bench/results/vision-*-2026-09-22.json`).

| set | raw accuracy (argmax) | decided | precision among decided | errors removed by abstention |
|---|---|---|---|---|
| MNIST test, 150 handwritten digits (28×28 → 112) | 80.0 % | 123/150 | **97.6 %** | 24 of 27 |
| CIFAR-10 test, 150 real colour photos (32×32 → 128) | 60.7 % | 95/150 | **95.8 %** | 55 of 59 |
| rendered text pages, 50 | **100 %** | 50/50 | 100 % | — |
| UI screenshot panels, 50 | **100 %** | 50/50 | 100 % | — |

What to read from this, and what NOT to: the raw accuracy of MNIST and CIFAR-10 is the MODEL's
vision, not the readout's — a 32×32 CIFAR photograph is a genuinely hard input. What the readout
adds is the abstention: at `theta = 0.5` it removed 55 of 59 CIFAR errors and 24 of 27 MNIST
errors, keeping 4 and 3 wrong verdicts respectively, at the price of abstaining on 18-36 % of the
images. The text and screenshot sets are RENDERED locally (Pillow, `bench/vision-text-gen.py`),
ground truth by construction — they validate text and UI reading at clean resolutions, not noisy
photography. One model, one engine, one point of the theta curve per set; ±1 verdict of inter-run
variance was observed on the MNIST set between two identical runs.
