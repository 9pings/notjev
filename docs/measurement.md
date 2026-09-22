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
