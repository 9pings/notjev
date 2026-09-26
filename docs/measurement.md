# Measuring it on your own questions

The numbers in this library's documentation are provenance, not a promise about yours. This page is
how you get your own.

## theta, bands, coverage — how to actually use them

* **theta is not a constant, it is a curve.** Record a set of questions with a truth column, then
  read `coverage x precision` and pick the point you can afford. `0.5` is a default, not an answer.
* **Never write `p1` as if it were a measurement.** Between two engines serving the same weights,
  2.3-10.4 % of verdicts differ — but 0-0.1 % among those at `p1 >= 0.9`. Store `band`/`prior`.
* **`coverage` is your smoke alarm.** A run whose mean coverage drifts down is a run whose prompt no
  longer fits the model: the mass went somewhere outside your menu.
* **`degraded` is never "it hesitates"**. It means the answer was not in your codomain at all.

## Record, replay, report

Record the responses while you run, replay them for free afterwards — re-tune theta on last week's
run without touching a GPU:

```js
const fs = require('fs');
const { createClient } = require('notjev');
const jev = createClient();

const questions = [
  { id: 'q1', options: ['SAME', 'OTHER'], gold: 'SAME',  state: 'A: "Sarah Knafo" / B: "Sarah Knafot"\n' },
  { id: 'q2', options: ['SAME', 'OTHER'], gold: 'OTHER', state: 'A: "Paris, France" / B: "Paris, Texas"\n' },
];

(async () => {
  const results = [];
  for ( const q of questions ) {
    const r = await jev.decide({ state: q.state, question: 'verdict', options: q.options, theta: 0 });
    results.push({ id: q.id, options: q.options, gold: q.gold, ms: r.ms, resp: r.raw });
  }
  fs.writeFileSync('run.json', JSON.stringify({ model: jev.model, results }, null, 1));
  console.log('recorded', results.length);
})();
```

```js
const fs = require('fs');
const { replay, report } = require('notjev');

const { rows } = replay(JSON.parse(fs.readFileSync('run.json', 'utf8')), { theta: 0, truth: 'gold' });
const rep = report(rows, { positive: 'SAME' });

console.log('accuracy', rep.accuracy.accuracy, 'null arm', rep.accuracy.nullArm.accuracy);
console.log('ECE', rep.ece.ece);
for ( const s of rep.sweep ) console.log('theta', s.theta, 'coverage', s.coverage, 'precision', s.precision);
```

`report` never gives you an accuracy alone: the **null arm** (always answer the majority class) and
the **oracle arm** come with it. A bar the null arm already clears measures nothing.

## The letter prior — estimate, apply, publish

The flips you measure with `harness.permute` are, in part, the model's prior over the LETTER
TOKENS, not over the content (Zheng et al., ICLR 2024, arXiv:2309.03882 — PriDe). The library
carries the correction as an explicit, published layer:

```js
const { harness, tokenizer } = require('notjev');

// 1. INVENTORY the surface forms, against the deployed server — the detokenised piece it hands
//    back is what `distribution` buckets, not the HF decode. `multi` is refused by `strict`.
const inv = await tokenizer.checkSpacedLetters(
  tokenizer.makeHttpTokenizer({ baseUrl, kind: 'vllm', model }), ['A', 'B']);

// 2. ESTIMATE the prior: run each question under BALANCED orders (at K = 2: the identity + the
//    swap — the consecutive seeds of `permute` all give the SAME order, and an unbalanced set
//    reads the content marginal as a letter prior), and keep the PERMUTED arms in the presented
//    frame (before `unpermute` — the prior is per LETTER). Label-free; degraded arms are excluded
//    by `letterPrior` itself; the estimand is the RAW `mass` of the decision, not the renormalised
//    probabilities (that average is biased — named test in the suite).
const fit = harness.letterPrior(permutedDecisions, { split: 'calib-2026-09', tokenizer: 'qwen3' });
console.log('prior', fit.prior, 'kl', fit.kl.toFixed(4), 'n', fit.n);

// 3. APPLY it per decision — the prior is echoed, and `coverage` never moves.
const r = await jev.decide({ state, question, options, letterPrior: fit.prior });
```

The rules that keep it a measurement and not a setting:

* **Balanced orders, raw mass.** The two named biases of the estimator (unbalanced orders → the
  content reads as a prior; renormalised average → a 0.8/0.2 prior reads 0.64/0.36) are paid for
  in `test/harness.test.js` — the recipe is part of the method, not folklore.
* **Out of sample.** The prior applied to a question should be estimated WITHOUT that question's
  arms (`bench/letters.js` does leave-one-question-out and prints the in-sample number only as the
  mechanism's ceiling).
* **Per (model, tokenizer, menu size).** A prior carried across any of those is a transfer:
  publish it with `split` and `tokenizer`, like a fitted `T` (`undeclared` by default).
* **`coverage` stays on the raw mass.** The correction re-weights the options against each other,
  never the options against the rest of the vocabulary.
* **What to expect (measured 2026-09-26 on the campaign engines, K = 2)**: production states →
  prior near-uniform (kl ≈ 0.007), correction NEUTRAL, flips 7.5 % (27B) / 15 % (8B); short
  synthetic states → prior concentrates (8B kl 0.119, flips 65 % → 52.5 % after correction). The
  letter prior depends on the QUESTION REGIME as much as on the model — measure on YOUR states,
  and label the instrument (the native CPU path is not equivalent to the GPU engines).
  `node bench/letters.js --base-url … --model … [--backend llama|chat] --raw out.json`.
* **Temperature does not do this.** `calibration` is right that the argmax is invariant under T:
  fitting T changes what you may say about `p1`, it moves no flip. The prior is the layer that can.

