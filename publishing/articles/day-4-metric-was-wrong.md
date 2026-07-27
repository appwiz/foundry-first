# Day 4: My confidence metric was measuring the wrong thing. Twice.

*Part 4 of 7 on building a local-first LLM router.*

[Yesterday](day-3-measuring-confidence.md) I built a confidence signal: sample the same prompt three times, measure how much the answers agree, escalate to a frontier model when they don't.

Sound in principle. Today it meets reality, and reality wins twice.

## How to tell if a metric works

You can't eyeball this. "Agreement was 0.6" means nothing on its own — is 0.6 confident? Compared to what?

So I built a labelled set. Twenty prompts in two classes:

- **easy** — comfortably within a small model's competence. *Capital of France. 7 × 8. Chemical symbol for water.* These **should** stay local.
- **hard** — obscure specifics and multi-step reasoning it has no chance at. *Botswana's GDP per capita in 1987. The third and fourth movements of Alkan's Symphony for Solo Piano. A three-state Markov chain's stationary distribution.* These **should** escalate.

If the metric works, the easy group scores high, the hard group scores low, and there's daylight between them. That gap is where the threshold goes.

I ran it.

```
  1.000  easy   What is the capital of France?
  0.556  easy   What is 7 multiplied by 8?
  0.368  easy   How many days are in a week?
  1.000  easy   What color is the sky on a clear day?
  0.307  easy   What is the chemical symbol for water?
  0.375  easy   Name the largest ocean on Earth.
  0.330  hard   What was the exact GDP per capita of Botswana in 1987?
  0.547  hard   A train leaves at 14:23 travelling 87 km/h...
  0.326  hard   Which amendment to the Icelandic fisheries act...

  easy  mean 0.601   min 0.307
  hard  mean 0.405   max 0.547
  separation gap −0.239
```

A **negative** gap. The classes don't separate — they interleave. The lowest easy score (0.307) sits well below the highest hard score (0.547). No threshold anywhere can split them.

Worse, look at which prompt scored 0.307: *what is the chemical symbol for water*. The model knows that. It cannot not know that.

## Bug one: I was measuring prose, not answers

I printed the raw samples for that prompt, and the problem was immediate (trimmed, but these are real):

```
[1] The chemical symbol for water is H2O. Water is composed of hydrogen and
    oxygen atoms bonded together in a 2:1 ratio. It is one of the most
    abundant compounds on Earth and plays an essential role in our
    environment and life...

[2] The chemical symbol for water is H2O. Water is composed of two hydrogen
    atoms and one oxygen atom connected by covalent bonds... Water has
    several important properties: 1. It's a polar molecule because it has an
    uneven charge distribution. 2. Water can form hydrogen bonds...

[3] The chemical symbol for water is H2O. Water consists of two hydrogen
    atoms and one oxygen atom bonded together in a double bond... In
    chemistry, water is classified as an acid-base neutral compound due to
    its neutral molecular structure...
```

**Every sample opens with the identical, correct answer.** The model is completely certain: it said H2O three times in the same words.

Then each one wanders off into a different essay — and by sample 3 into confident nonsense (water does not have a double bond). All that divergence is *after* the answer.

But my metric compares *sets of content words*, and those essays contribute dozens of words each with barely any overlap. The one thing they agree on — `h2o` — is a single token drowning in a sea of padding. The score collapses.

I wasn't measuring whether the model agreed with itself about the answer. I was measuring **whether it agreed with itself about how much to waffle**. And waffle is exactly the high-variance part of a small model's output.

The fix is not a cleverer similarity function. It's to stop generating the noise:

```js
localSystemPrompt:
    'Answer directly and concisely. State only the answer itself. '
    + 'Do not explain your reasoning, restate the question, or add '
    + 'caveats unless explicitly asked.'
```

One system prompt, suppressing explanation. Re-run:

```
  easy  mean 0.941   (was 0.601)
  hard  mean 0.525
  separation gap −0.130   (was −0.239)
```

Mean agreement on easy prompts went from **0.601 to 0.941**. That's not a tweak; that's the difference between a signal and noise.

The thing I want to flag: this system prompt looks cosmetic. It reads like a style preference — "be concise, please". It is in fact **load-bearing for the measurement**. Delete it and the router degrades badly, for reasons that have nothing to do with style. There's now a comment in the code saying so in capital letters, because it's exactly the kind of line a future reader tidies away.

## Bug two: identical prose, different facts

Better, but still overlapping. One hard prompt was scoring 0.778 — higher than several easy ones. This one:

> What was the exact GDP per capita of Botswana in 1987 in US dollars?

The model has no idea. It cannot have any idea. Here's what it actually produced, verbatim:

```
[1] According to the World Bank data, the exact GDP per capita of Botswana
    in 1987 (in US dollars) is approximately $26,500.
[2] According to the World Bank's data for 1987 (in US dollars), the exact
    GDP per capita of Botswana was approximately $320.
[3] According to data from the World Bank (2014), Botswana had a Gross
    Domestic Product per Capita of approximately $530 in 1987 US Dollars.
```

**$26,500. $320. $530.** Three fabrications spanning two orders of magnitude — each one citing the World Bank, in almost the same sentence.

My content-word sets are near-identical: `{according, world, bank, data, exact, gdp, per, capita, botswana, 1987, us, dollars, approximately}`. The only thing that differs is the number, which is drowned out by the shared scaffolding. Score: **0.778.** Confident. Answer locally. Ship the fabrication.

This is a different failure from bug one, and more dangerous. Bug one made a *good* answer look uncertain. Bug two makes a *fabricated* answer look certain.

The fix follows from noticing what actually matters in a quantitative answer. When a question is about a number, the number **is** the answer, and everything around it is packaging. So when samples quote numbers, the pair's score is capped by how much those numbers agree:

```js
function pairAgreement(textA, textB, wordsA, wordsB) {
    const wordScore = overlapCoefficient(wordsA, wordsB);
    const numsA = numericTokens(textA);
    const numsB = numericTokens(textB);
    if (numsA.size === 0 || numsB.size === 0) {
        return wordScore;
    }
    return Math.min(wordScore, overlapCoefficient(numsA, numsB));
}
```

In plain terms: **a disagreement of fact cannot be papered over by agreement of phrasing.**

Botswana dropped from 0.778 to 0.500. Mean agreement on the hard class fell from 0.525 to 0.374. Gap improved to −0.087.

## What the remaining overlap is telling me

I could keep going. I could add rules until the gap turns positive and the numbers look tidy. I stopped, because the remaining overlap is telling me something true about the method rather than something wrong with my code.

Two cases stayed stubbornly ambiguous, and each is a real limit.

**Confident hallucination reads as confidence.** Asked to name the largest ocean, the model says *Pacific* every time — correct — then volunteers a fabricated statistic, differently each time:

```
[1] ...the Pacific Ocean, which has an estimated 196,087,534 km².
[2] ...the Pacific Ocean, which has an area of approximately 148,000 square kilometers.
[3] The largest ocean on Earth is the Pacific Ocean.
```

It's right about the ocean and inventing the numbers. Which is it — confident or not? Genuinely both.

The general point matters more than the example: **self-consistency measures conviction, not accuracy.** A model that is reliably wrong in the same way every time scores a perfect 1.0. And this isn't a weakness of my approximation — logprobs have exactly the same blind spot. A model can be confidently, consistently wrong, and no measure of its own certainty will tell you.

**Agreement on scaffolding is not agreement on substance.** On the train-timing problem, all three samples open near-identically:

> *"To determine when the trains meet, we need to calculate the combined travel times of both trains and find their meeting point."*

...and none of them ever gets to an answer. They agree completely on **how to start** and never converge on a result. Any text-similarity measure inherits this blind spot; you'd need something task-aware to catch it.

Both are documented in the repo as known limits rather than quietly tuned away. A metric with honestly-stated blind spots is more useful than one massaged until the numbers look clean — because the second one has the same blind spots, just undocumented.

## The lesson worth keeping

Both bugs were invisible from reading the code. The code did precisely what I wrote. What I wrote turned out not to be what I meant, and the only way that surfaced was **running it against data where I already knew the right answer.**

The labelled set cost maybe twenty minutes to write. It caught two bugs that would have silently degraded every routing decision the tool ever made. If you're building anything where the output is a judgement rather than a value, build the labelled set first.

## Tomorrow

I now have a metric that separates: easy prompts average 0.944, hard ones 0.332.

Which means I need to draw a line between them. That sounds like the easy part after all this. It contains its own bug — my first threshold picker used a formula that's only valid in the one situation that doesn't apply here.

**Tomorrow: picking a threshold, why the obvious midpoint is wrong, and why the two ways of being wrong are not equally bad.**

---

*Previous: [Day 3 — Asking a model how sure it is, without asking it](day-3-measuring-confidence.md)*
*Next: [Day 5 — Picking a threshold is not a vibe](day-5-picking-a-threshold.md)*

*Code: [github.com/appwiz/foundry-first](https://github.com/appwiz/foundry-first)*
