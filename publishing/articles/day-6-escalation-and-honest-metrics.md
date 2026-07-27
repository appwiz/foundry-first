# Day 6: Calling in the expert, and counting the savings honestly

*Part 6 of 7 on building a local-first LLM router.*

Five days in, the local half works. It answers what it can and — [as of yesterday](day-5-picking-a-threshold.md) — knows when it can't, at a threshold derived from measurement rather than taste.

Today: what happens when it can't. And then the part I got wrong, which is the arithmetic.

## Don't throw away the work

The naive escalation is to discard the local attempt and ask the frontier model fresh. That's a waste. Those three disagreeing drafts are *information* — they're a map of where the small model got confused.

So they go along as context, framed carefully:

```
You are the escalation tier of a two-tier answering system.

A small local model answered this question first, but its answer was
flagged as low confidence: sampled several times, its answers disagreed
with each other. The disagreeing drafts are provided as context.

Treat the drafts as evidence of what the small model found uncertain,
not as authority. Where a draft is right, you may build on it; where it
is wrong or confused, correct it silently. Do not narrate the drafts,
grade them, or mention that a local model was involved — just answer
the user's question directly and correctly.
```

The framing does real work. "Evidence, not authority" keeps the frontier model from deferring to a confident-sounding fabrication. "Don't narrate" stops it producing a critique of the small model instead of an answer, which it will otherwise happily do.

## It earned its keep immediately

Remember Day 1's fabrication? Asked which amendment introduced Iceland's transferable fishing quotas, the local model confidently invented:

> **Article 247-5-1** of the Icelandic Act on the Development of the Fishing Industry.

Agreement across three samples: **0.000**. Complete disagreement. Escalate.

The frontier model came back with:

> **Short answer: none — the premise doesn't hold.** Transferability was not added later by amendment; it was built into the Fisheries Management Act itself (Lög nr. 38/1990), which the Althingi passed in May 1990 and which took effect on 1 January 1991.

It didn't just answer better. **It rejected the premise of the question.** There was no such amendment to find, because the provision was in the original Act. The local model, asked to name an amendment, obligingly invented one — which is exactly what a model does when a question presupposes something false.

That's the routing thesis working end to end: the cheap tier flagged its own uncertainty, and the expensive tier fixed both the answer and the question. Cost: about 16 seconds and 1,500 tokens, for the small fraction of questions that need it.

## Failure shouldn't cost you the answer

The frontier tier can fail for reasons that have nothing to do with the question — no credentials, no network, rate limits, an expired token. None of that should leave the user with nothing, because there's a perfectly good local draft sitting right there.

```js
try {
    entry = await runEscalation(opts, samples, decision, entry);
} catch (err) {
    entry.escalationFailed = true;
    console.log(selectRepresentative(samples).text.trim());
    console.error(`[local fallback · escalation needed (${decision.reason}) but unavailable]`);
}
```

Print the local answer, say plainly that it's a fallback and why. The user gets something, and knows what they're getting.

Hold on to that `entry.escalationFailed = true` line. It exists because of a bug I'll get to in a moment.

## Now: what does this actually save?

The whole premise is that routing saves money and time. That's a claim, and claims about savings are exactly where systems like this quietly start lying to their owners.

Some of it is easy — the real numbers are right there:

```js
inputTokens: message.usage?.input_tokens ?? 0,
outputTokens: message.usage?.output_tokens ?? 0,
```

Frontier token counts come from the API's own accounting. Local counts come from the SDK's. Both exact, no estimation.

The hard part is the savings, because **a call you didn't make has no cost to measure.** You can't observe the price of something that didn't happen.

I could have assumed a number. Lots of dashboards do — pick a plausible per-call cost, multiply by calls avoided, put it on a slide. That number would be fiction dressed as measurement.

What I do instead: price each avoided call at the **measured mean of the escalations that actually happened**.

```js
const meanRemoteTokens = hasBaseline ? remoteTokens / escalated : null;
estimatedTokensAvoided: hasBaseline
    ? Math.round(meanRemoteTokens * localSufficient)
    : null,
```

And critically — until at least one escalation has completed, there's no baseline, so it reports nothing rather than guessing:

```
Frontier tokens avoided  n/a — no escalation yet to measure a baseline against
```

Once there's real data:

```console
$ node index.js --stats
  Requests                5
  Answered locally        4  (80.0%)
  Escalated               1

  Local tokens            1,021  (free, on-device)
  Frontier tokens spent   1,503  (457 in / 1,046 out)
  Frontier tokens avoided ~6,012  (est. from measured mean)

  Mean local latency      3.1s
  Mean frontier latency   16.0s
  Latency avoided         ~64.0s  (est. from measured mean)
```

Note the `~` and the parenthetical on the avoided rows. Those are estimates and they say so. The rows above them are measurements and don't need the qualifier. Being able to tell which is which at a glance is the whole point.

## The bug: my metrics counted failures as successes

Go back to that error handler. When escalation failed, the code printed the local draft and carried on — and `entry.escalated` was still `false`, because the frontier call never returned.

Then this ran:

```js
if (entry.escalated) {
    next.escalated += 1;
} else {
    next.localSufficient += 1;   // ← the bug
}
```

A **failed escalation was being counted as local sufficiency.**

Think about what that does to the headline number. The router looked at those questions and judged them *too hard for the local tier* — they're the strongest evidence against the claim "the local model handles most things". And the failure path was quietly filing them under "handled locally". The metric got better precisely when the system worked worse.

I caught it because I was testing without credentials, so every escalation failed, and the tool cheerfully reported **100% local sufficiency**. A number that good should always feel like a bug.

The fix is a third category:

```js
if (entry.escalationFailed) {
    next.escalationFailures += 1;      // neither success nor completed escalation
} else if (entry.escalated) {
    next.escalated += 1;
} else {
    next.localSufficient += 1;
}
```

...and excluding it from the rate entirely. Neither tier answered those questions, so they belong in neither bucket.

The general lesson is worth more than the specific bug: **whenever a catch block substitutes a lesser result, ask what it does to your numbers.** A fallback fires on the hard cases by construction. Folding it into the success bucket doesn't just add noise — it systematically biases the metric in the flattering direction, using the exact cases that disprove it.

## A second thing I got wrong: trusting an error code

Related habit, learned painfully.

For most of this project I had no API credits, so I couldn't complete a real frontier call. I sent a request with a deliberately invalid key and got a **401**. My reasoning: 401 is an *auth* error, not a *validation* error, so the request body must have been accepted. The parameters are fine.

That reasoning is wrong, and I only found out because I ran the control: same invalid key, plus a deliberately bogus beta header. If the body were being validated, that should fail differently.

It returned the same 401. Auth is checked first; the body was never examined. My "proof" proved nothing.

The same trap sprang again later. With credits still absent, a valid request returned a **400** — which looks like a parameter problem. Control test: a valid body, a bogus header, and a parameter the model definitively rejects all returned the *identical* `credit balance is too low` error. Billing is checked before validation too.

**An error code is only evidence if a control produces a different one.** Send something that *should* fail differently and confirm it does. Otherwise you're reading tea leaves with a status code.

(Once credits were added, the real call went through first time and the parameters were fine all along. But I didn't *know* that until it did.)

## Tomorrow: the finale

The system is complete and working. There's one assumption left that I never checked.

I picked `qwen2.5-0.5b` on Day 1 because it was small and downloaded fast. That's not a reason. Foundry Local's catalog has around twenty-five chat models — surely something bigger would be better?

I benchmarked five of them properly. **Three turned out to be completely unusable with this technique, the bigger models scored dramatically worse than the small one, and the reason had nothing to do with model quality.**

**Tomorrow: the benchmark, and the most surprising thing I found in the whole project.**

---

*Previous: [Day 5 — Picking a threshold is not a vibe](day-5-picking-a-threshold.md)*
*Next: [Day 7 — I benchmarked five local models. Three couldn't be used at all.](day-7-benchmarking-models.md)*

*Code: [github.com/appwiz/foundry-first](https://github.com/appwiz/foundry-first)*
