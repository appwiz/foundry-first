# Day 3: Asking a model how sure it is — without asking it

*Part 3 of 7 on building a local-first LLM router.*

[Yesterday](day-2-why-route.md) I landed on the question this whole project turns on: before showing the user a locally-generated answer, how do I decide whether to trust it?

I ruled out asking the model to rate itself. A system that confidently invents a legal citation is not a reliable narrator about whether it just invented a legal citation. I want something *measured* rather than *reported*.

There's a standard answer for this. Let me explain it, and then explain why I couldn't use it.

## The textbook signal: logprobs

When a language model generates text, it doesn't pick words. At each step it produces a probability distribution over every token in its vocabulary, then samples from it.

That distribution is the model's uncertainty, made concrete. If the model is sure, one token holds most of the probability mass. If it's guessing, the mass is spread thin across many plausible continuations.

Most APIs will hand you those numbers as **logprobs** — the log of the probability assigned to each token that was actually generated. Average them across a response and you have a single number describing how confident the model was, in a rigorous sense. Exponentiate the negative and you get perplexity, the same idea in a different unit.

This is exactly what I want. It's objective, it's free — the model already computed it — and it's the thing every ML person reaches for first.

So I went looking for it.

## It isn't there

I checked both paths the SDK offers.

**The in-process chat API.** I dumped the entire response object rather than trusting the types:

```js
const r = await chatClient.completeChat([{ role: 'user', content: 'What is 2+2?' }]);
console.log(Object.keys(r.choices[0]));
// [ 'delta', 'message', 'index', 'finish_reason' ]
console.log(r.choices[0].logprobs);
// undefined
```

No `logprobs` field at all.

**The HTTP path.** Foundry Local can also expose an OpenAI-style Responses API over localhost. Its TypeScript types were promising — there's a `LogProb` interface right there in `types.d.ts`, with `token`, `logprob`, and `bytes`. So I started the web service and asked:

```js
const r = await responsesClient.create('What is 2+2? One word.');
const out = r.output[0].content[0];
console.log(Object.keys(out));
// [ 'type', 'text', 'annotations', 'logprobs' ]
console.log(out.logprobs);
// []
```

The field exists. It comes back empty. And there's no request parameter anywhere in `ResponseCreateParams` to ask it to be populated.

So the type is real, the field is real, and the local runtime never fills it in. That's a dead end — a well-typed, thoroughly documented dead end.

**A small aside on method:** I could have read the docs and concluded logprobs weren't supported. Instead I probed both paths and looked at the actual objects. That's a habit worth keeping. Types describe what a field *would* contain; only running the thing tells you what it *does* contain. Half this series is that lesson in different costumes.

## Plan B: ask the same question several times

If I can't read the model's probability distribution directly, I can **sample from it** and look at the spread.

Run the same prompt three times at a non-zero temperature, with different random seeds. Each run is an independent draw from that same distribution. Then:

- If the model *knows* the answer, the distribution is sharp and all three samples say the same thing.
- If it's *guessing*, the distribution is flat and it guesses differently each time.

**Agreement between samples estimates the entropy of the distribution** — the same quantity logprobs would have told me directly. I'm not reading the number; I'm measuring its consequence.

This is a well-established idea. It shows up as *self-consistency* in the reasoning literature, and as sampling-based uncertainty estimation more broadly. What matters for my purposes is that it's a **measurement, not a self-report**: I never ask the model anything about its confidence. I compute a number from outputs I observed.

Here's what it looks like in practice. An easy question:

```
[draft 1] Paris
[draft 2] Paris
[draft 3] Paris
agreement 1.00 → answer locally
```

And an obscure one — *which amendment introduced Iceland's transferable fishing quotas?* Three real samples, verbatim:

```
[draft 1] The specific amendment was the 52nd in number (1996), which added
          a new section to the Icelandic Fisheries Management Act.
[draft 2] The transferable quota provision was introduced by the Iceland Act
          of 2005.
[draft 3] The specific amendment to the Icelandic Fisheries Management Act
          that introduced the transferable quota provision was the 36th
          Amendment (No. 36) to Article 27 on July 8, 2015.
agreement 0.00 → escalate
```

Three different amendments, three different years — 1996, 2005, 2015 — each stated with total assurance. **Agreement: 0.000.** Not a single content word in common.

The model doesn't tell me it's unsure. It *demonstrates* it by contradicting itself three times running.

## Turning that into a number

I need a similarity measure over short text answers. I reduce each sample to its set of content words — lowercased, punctuation stripped, stopwords removed — and compute the mean pairwise **overlap coefficient** across all pairs:

```
|A ∩ B| / min(|A|, |B|)
```

I picked overlap rather than cosine similarity or Jaccard for a specific reason: **answer length varies far more than answer content**. "Paris" and "The capital of France is Paris" agree completely on substance, but a length-sensitive measure scores that pair as substantial disagreement. Overlap ignores the padding.

It has an obvious weakness — a short sample fully contained in a longer one always scores 1.0 — which is why the scorer also disqualifies degenerate samples before trusting the number. More on how this metric had to be repaired tomorrow.

Two facts about the generation bypass the score entirely and force escalation, because they make agreement meaningless rather than low:

- **`finish_reason === 'length'`** — the sample was cut off at the token limit. It's an incomplete thought; agreement between fragments proves nothing.
- **A sample with no content words** — there's nothing to agree about.

## The one setting that silently breaks everything

Temperature controls how much randomness goes into sampling. At temperature 0, the model always takes the highest-probability token, and generation is deterministic.

Which means at temperature 0, **all three samples are byte-identical, agreement is exactly 1.0, and it is always 1.0** — for a question the model knows cold and for one it's fabricating wholesale.

Nothing errors. No warning. The confidence signal just quietly stops containing information, the router stops escalating, and your local tier starts presenting fabrications as fact with a reassuring `agreement 1.00` next to them.

That's the worst class of bug: a system that looks like it's working. I set temperature to 0.7 and left a comment in the code explaining why it must never be zero.

(Foreshadowing: on Day 7 I discover this exact failure happening at temperature 0.7, through no fault of my configuration, on most of the models I tested. That one took a while to see.)

## What it costs

This isn't free. Three samples means **three local inferences per question** instead of one — roughly triple the local latency.

That's the price of an objective confidence signal when logprobs aren't available. It's paid in local compute, which is free in money terms, and it buys the ability to avoid frontier calls. For this design the trade is clearly worth it, but it's a real cost and worth stating rather than hiding.

If a future SDK release starts populating `logprobs`, mean log-probability drops straight into the same function and the sampling cost disappears. I structured the code so that's a one-function change.

## So: solved?

I have an objective, measured confidence signal that doesn't ask the model to introspect and doesn't require a second system.

I wired it up, pointed it at a set of questions I'd labelled easy and hard, and expected to see the easy ones score high and the hard ones score low.

That is not what happened. The two groups overlapped so badly that no threshold could separate them — and the reason turned out to be that my metric was measuring something other than what I thought.

**Tomorrow: the two bugs, and what "three samples that all said H2O scored 0.307" taught me about the difference between an answer and the words around it.**

---

*Previous: [Day 2 — Why route between two models at all](day-2-why-route.md)*
*Next: [Day 4 — My confidence metric was measuring the wrong thing. Twice.](day-4-metric-was-wrong.md)*

*Code: [github.com/appwiz/foundry-first](https://github.com/appwiz/foundry-first)*
