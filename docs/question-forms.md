# The three question forms, and what comes back

A closed question is one whose answers you can write down before asking. The library supports
exactly three of them — the three closed forms of the readout.

## The forms

```js
const { createClient } = require('notjev');
const jev = createClient();

(async () => {
  // 1. a closed list — the codes come back as `choice`, in YOUR order
  const a = await jev.decide({
    state   : 'The minister announced a plan on Tuesday.\n',
    question: 'event type',
    options : [
      { id: 'ANNOUNCE', description: 'someone makes something public' },
      { id: 'MEET',     description: 'two parties meet' },
      { id: 'VOTE',     description: 'a ballot is held' },
    ],
    theta: 0.3,
  });
  console.log(a.choice, a.value, a.byOption);

  // 2. a boolean — YOU provide the two options, in your language, or not at all
  const b = await jev.noul('The minister announced a plan.\n', 'is this about policy?',
    { yes: 'YES', no: 'NO' });
  console.log(b.value, b.p1.toFixed(3));   // true 0.97

  // 3. a scale — read on the digits, with the expectation over the whole distribution
  const c = await jev.score('The minister announced a plan.\n', 'how concrete is it?', { min: 1, max: 5 });
  console.log(c.value, c.expectation && c.expectation.toFixed(2));
})();
```

An option is a bare code or `{ id, description }` — a description renders `id: description` in the
menu and **changes the prompt, therefore the measurement**. The published numbers were obtained with
bare codes.

N questions on one state — one request each, so each one is still one token. The server's prefix
cache makes the shared state nearly free:

```js
const { createClient } = require('notjev');
const jev = createClient();

(async () => {
  const rows = await jev.decideMany('The minister announced a plan on Tuesday.\n', [
    { id: 'kind',   question: 'event type', options: ['ANNOUNCE', 'MEET', 'VOTE'] },
    { id: 'policy', question: 'is this about policy?', noul: { yes: 'YES', no: 'NO' } },
    { id: 'depth',  question: 'how concrete is it?', score: 5 },
  ], { concurrency: 1 });

  for (const r of rows) console.log(r.id, r.choice, r.p1.toFixed(3), r.band, r.undecided);
})();
```

There are **26 options maximum** — one letter, one token. Beyond that the question is refused, never
truncated: split it.

## What comes back

| field | what it is |
|---|---|
| `choice` | the code, or **`null`** — `null` is not a fallback, it is the absence of a verdict |
| `value` | the re-typed answer: the code, a boolean (`noul`), an integer (`score`) |
| `expectation` | `score` only: the mean grade under the whole distribution |
| `top` | what the model would have said without the margin — readable, never applied |
| `p1`, `p2`, `margin` | on the distribution **renormalised over the options** |
| `band` | `low` < 0.5 <= `med` < 0.75 <= `high` < 0.9 <= `certain` |
| `prior` | the **middle of the band** — what stays true across engines, unlike the raw float |
| `coverage` | the option mass **before** renormalisation. Low = the model meant something else |
| `exactMass` / `spacedMass` | `"A"` vs `" A"`, counted apart so the matching rule is auditable |
| `degraded` | `true` when no option letter appeared at all. Then `choice` is `null`, always |
| `undecided` | `margin < theta`, or degraded |
| `probabilities`, `byOption` | sums to 1 over the options |
| `prompt`, `request`, `raw`, `readoutRaw` | the exact string, the exact body, the server response, and the distribution as a one-line JSON for your logs |
| `ms`, `usage`, `model` | the call itself |

`jev.prompt(q)` builds the exact string **without sending anything**. Read it before theorising
about the model: it is the first rung of every diagnosis.
