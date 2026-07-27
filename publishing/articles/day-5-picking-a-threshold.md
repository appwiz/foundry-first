# Day 5: Picking a threshold is not a vibe

*Part 5 of 7 on building a local-first LLM router.*

By [yesterday](day-4-metric-was-wrong.md) I had a confidence metric that works: easy prompts average **0.944**, hard ones average **0.332**.

All that's left is drawing a line between them. Below the line, escalate. Above it, answer locally.

This is the part I assumed would take five minutes.

## The number nobody justifies

Every system like this has a magic constant somewhere:

```js
if (confidence < 0.7) {
    escalate();
}
```

Where did 0.7 come from? Usually: someone tried a few values, 0.7 seemed fine, and it's been there ever since. It gets copied into the next project. Nobody revisits it when the model changes.

I wanted this one to be defensible — a number I could point at a measurement to justify. I already had the labelled set from Day 4, so the machinery was there.

## Attempt one, and the bug in it

The obvious approach: find the gap between the two classes and split it.

```js
const gap = min(easyScores) - max(hardScores);
const midpoint = (min(easyScores) + max(hardScores)) / 2;
```

Clean. Symmetric. Wrong.

It's only correct when the classes **separate cleanly** — when the worst easy prompt still scores above the best hard one. Then there's a real gap and its midpoint is genuinely the safest place to cut.

My classes overlap. The gap is −0.087; the worst easy prompt scores *below* the best hard one. In that situation the "midpoint" is just some point inside the overlap with no claim to being good at anything. It computed 0.54, which routed 9 of 12 prompts correctly at the time.

The fix is to stop being clever and just try every value:

```js
for (let i = 0; i <= 100; i += 1) {
    const t = i / 100;
    steps.push({ t, outcomes: outcomesAt(rows, t) });
}
```

Sweep 0.00 to 1.00, count the mistakes at each, pick the best. It found **0.59 — 11 of 12 correct**, two better than the formula that looked more sophisticated.

The lesson generalises past thresholds: when you're optimising over a single bounded parameter and you can evaluate it cheaply, **just sweep it**. A closed-form shortcut is only worth it if you've checked its assumptions hold, and mine didn't.

## The two mistakes are not equal

The sweep needs to know what "best" means, and my first version counted total misclassifications — one prompt wrong is one prompt wrong.

That's not right either, because the two ways of being wrong have completely different costs:

**An easy question that escalates unnecessarily.** You paid for a frontier call you didn't need. Cost: some tokens and a couple of seconds. Annoying.

**A hard question kept local.** The user gets Article 247-5-1 — a fabricated citation, delivered fluently, with no indication anything is wrong. Cost: they believe it.

These are not the same and shouldn't trade off one-for-one. The second is the failure the entire system exists to prevent. So the sweep minimises **wrong answers kept local** first, and only maximises **correct answers kept local** as a tie-break:

```js
const better = o.localWrong < best.localWrong
    || (o.localWrong === best.localWrong && o.localCorrect > best.localCorrect);
```

Encoding the asymmetry in the objective rather than in a comment means it's actually enforced.

## Attempt two, and the bug in *that*

I wrote a unit test with synthetic data, because I'd learned by then not to trust code that produces plausible numbers. Easy prompts at 0.9 and 0.8, hard ones at 0.2 and 0.1 — clean separation, obvious answer.

```
clean  →  threshold 0.2000000000000004
```

It's *correct*. At that value the hard prompt scoring 0.2 escapes by a floating-point hair. Everything is classified perfectly.

It's also **flush against the nearest wrong answer**. Move that hard prompt from 0.200 to 0.201 and the threshold now keeps a fabrication local.

Why does that matter? Because these scores aren't stable. The metric samples a stochastic process — the same prompt on a different run gives slightly different agreement. I'd already watched one prompt score **0.587** during calibration and **0.554** in normal use. That's a swing of 0.03, and my sweep was picking margins of 0.000000004.

The sweep was finding the *first* threshold that worked rather than the *most robust* one. Fix: among all the values achieving the best outcome, take the midpoint of the widest contiguous band.

```
clean     →  threshold 0.50   (margin: 60 steps)
confwrong →  threshold 0.88   (correctly above a confidently-wrong 0.85)
overlap   →  threshold 0.80   (sacrifices one easy prompt to avoid one fabrication)
```

Same classifications, room to breathe on both sides.

Note that the midpoint *is* the right idea here — just applied to the right thing. Not the midpoint between the classes (which assumes separation I don't have), but the midpoint of the range of thresholds that actually achieve the best measured outcome.

## The answer, and what it costs

The final threshold is **0.76**. On the twenty-prompt set that gives:

- **9 of 20** answered locally and correctly
- **0** wrong answers kept local
- **11** escalated

Zero is the number I care about. Not one fabrication presented as fact.

And that 11 is the honest cost. Some of those escalations are questions the local model could have handled — the threshold is set conservatively on purpose, and conservative means paying for frontier calls you didn't strictly need. That's the trade I chose, and it's visible in the numbers rather than hidden.

Worth noting: the calibration set is deliberately half-hard, which is nothing like real traffic. On a realistic mix of questions the local share is much higher. The set exists to place the threshold, not to predict the hit rate.

## Re-run it when anything changes

The threshold isn't a property of my code. It's a property of **this model, at this temperature, with this many samples**. Change any of those and it's wrong.

That's why it's a command rather than a constant:

```console
$ node index.js --compare qwen2.5-0.5b
  best threshold 0.76 — 9/20 local-correct, 0 local-wrong
```

Anyone can re-derive it in a few minutes, and the comment above the constant in the code says exactly where it came from and when to regenerate it. A magic number with a reproducible provenance stops being magic.

## Tomorrow

The local half is done: it answers when it can, and knows when it can't.

Now the other half — actually calling the frontier model, handing it the local drafts so the work isn't wasted, and measuring what the whole arrangement saves.

That last part sounds like simple bookkeeping. **Tomorrow: the escalation path, one genuinely good save the frontier model made, and the bug that had my metrics counting failures as successes.**

---

*Previous: [Day 4 — My confidence metric was measuring the wrong thing. Twice.](day-4-metric-was-wrong.md)*
*Next: [Day 6 — Calling in the expert, and counting the savings honestly](day-6-escalation-and-honest-metrics.md)*

*Code: [github.com/appwiz/foundry-first](https://github.com/appwiz/foundry-first)*
