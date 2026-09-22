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
| space variants (`" A"` vs `"A"`) | <= 0.08 % of coverage |
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
