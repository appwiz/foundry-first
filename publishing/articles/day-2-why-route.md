# Day 2: Why route between two models at all

*Part 2 of 7 on building a local-first LLM router.*

[Yesterday](day-1-llm-on-your-laptop.md) I got a small language model running on my laptop in about 40 lines, and ended on the problem: it's fast, free, private, and frequently wrong in a way you can't detect by looking at the answer.

Today: what to do about that. And a small streaming detail that will print `undefined` at you until you spot it.

## First, make it feel alive

The Day 1 version blocks until the whole answer is ready, then dumps it. For a model that takes several seconds to write a paragraph, that's a long stare at a blank terminal.

Swapping to streaming is a small change:

```js
const chatClient = model.createChatClient();
for await (const chunk of chatClient.completeStreamingChat([
    { role: 'user', content: prompt }
])) {
    const content = chunk.choices?.[0]?.delta?.content;
    if (content) {
        process.stdout.write(content);
    }
}
process.stdout.write('\n');
```

Three things in there are load-bearing, and I got two of them wrong first time:

**`for await`, not `await`.** `completeStreamingChat()` returns an `AsyncIterable`, not a Promise. You iterate it; you don't await it.

**`delta.content`, not `message.content`.** Streaming chunks carry an *increment* — the new characters — rather than the message so far. If you reach for `message.content` out of habit you'll get `undefined` on every chunk.

**That `if (content)` guard is not defensive padding.** The field is genuinely *absent* on the first and last chunks, which carry role and finish-reason metadata instead of text. Without the guard you print `undefined` at both ends of every single response. It looks like a bug in the model. It's a bug in your loop.

Now tokens appear as they're generated, which makes a 3-second answer feel like a 0.3-second one. Same total time; completely different experience.

## The actual problem

Streaming makes the tool nicer. It doesn't make the model right.

Here's the tradeoff, stated plainly:

| | Small local model | Frontier model |
|---|---|---|
| Cost per question | Nothing | Real money |
| Latency | Under a second | Seconds, plus network |
| Privacy | Nothing leaves the machine | Your text goes to a third party |
| Works offline | Yes | No |
| Accuracy on hard questions | Poor, and confidently so | Good |

Most people pick a column and live with the downsides. But look at what you actually ask a system like this over a day. A lot of it is "what's the syntax for X", "convert this to Y", "what does this error mean" — questions a small model handles perfectly well. A smaller slice needs real reasoning or real knowledge.

If you send everything to a frontier model, you're paying frontier prices and frontier latency for "what is 7 times 8". If you send everything to the local model, you get fabrications like yesterday's non-existent Article 247-5-1 presented as fact.

**Neither column is the right default. The right default is per-question.**

## The shape of the thing

So: answer locally, and escalate only when the local model isn't up to it.

```
question
   │
   ▼
local model answers
   │
   ▼
is this answer trustworthy? ──── yes ──▶ return it (free, fast, private)
   │
   no
   │
   ▼
frontier model, given the local drafts as context
   │
   ▼
return the better answer
```

That's the whole design. It's not novel — this pattern shows up as "model cascades" or "LLM routing" in the literature, and various products do a version of it. But most implementations I've seen route on the *question* — classify it as easy or hard, send it accordingly.

I want to route on the *answer*, because that's the thing I can actually inspect. Routing on the question means predicting difficulty in advance, which is its own hard problem and gets no feedback from what the model actually did.

Two properties fall out of this design that I like:

**The local work isn't wasted when we escalate.** The local drafts go along as context. If the small model got part of it right, the frontier model can build on that instead of starting cold.

**Failure degrades gracefully.** No credentials, no network, rate limited — you still have the local answer in hand. Print it with a clear note rather than erroring out.

## The question that ate the project

Look at that flowchart again. There's one box doing all the work:

> **is this answer trustworthy?**

Everything else is plumbing. That box is the product.

And it has a constraint that makes it much harder than it looks: **you have to decide before showing the user anything.** You can't stream the local answer while you think about it, because if you stream it and then decide to escalate, you've already committed to an answer you don't trust. (This is why, in the finished tool, the local path deliberately doesn't stream — the routing decision has to come first. The frontier path streams, because by then the decision is made.)

So what are the options?

**Ask the model.** "How confident are you in that answer, 1–10?" Tempting, one line of code. It's also a *self-report* — you're asking a system that just fabricated Article 247-5-1 to introspect about whether it fabricated Article 247-5-1. Models are famously poorly calibrated at this, and a model confident enough to invent a citation is confident enough to rate itself a 9.

**Check it against something.** A knowledge base, a search index, a rules engine. Works well for narrow domains, but now you're building a fact-checking pipeline, and it doesn't generalise to "any question a user might type".

**Use a second model as a judge.** If the judge is the frontier model, you've just paid for the frontier call you were trying to avoid.

**Measure something objective about the generation itself.** No self-report, no external dependency, no second system. Just look at what the model actually did.

That last one is the only option that fits the constraint, and it's the direction I took. There's a textbook way to do it, and it's the first thing any ML person would reach for.

**Tomorrow: that textbook answer, why it turned out to be unavailable to me, and the substitute I used instead** — which is objective, sound in principle, and, as I'd discover on Day 4, extremely easy to get subtly wrong.

---

*Previous: [Day 1 — An LLM on your laptop in 40 lines](day-1-llm-on-your-laptop.md)*
*Next: [Day 3 — Asking a model how sure it is, without asking it](day-3-measuring-confidence.md)*

*Code: [github.com/appwiz/foundry-first](https://github.com/appwiz/foundry-first)*
