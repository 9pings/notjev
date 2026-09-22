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
