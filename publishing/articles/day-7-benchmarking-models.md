# Day 7: I benchmarked five local models. Three couldn't be used at all.

*Part 7 of 7 on building a local-first LLM router.*

The router works. It answers locally when it can, escalates when it can't, and [counts the results honestly](day-6-escalation-and-honest-metrics.md).

There's one assumption underneath all of it that I never checked. On Day 1 I picked `qwen2.5-0.5b` because it was the smallest thing that downloaded quickly. That's not engineering, that's convenience.

Foundry Local's catalog has around twenty-five chat models — from 0.5B up to 20B parameters, several newer generations than the one I grabbed. Some are *smaller* than my pick and newer. Surely I could do better?

Today I find out, and the answer is not the one I expected.

## First: what does "better" even mean here?

The obvious move is to rank models by agreement — whichever one produces the most self-consistent answers wins.

That's badly wrong, and it's worth understanding why, because it's the same trap as Day 4.

Agreement measures **conviction, not accuracy**. A model that's reliably wrong in the same way every time scores a perfect 1.0. Rank on agreement and you actively select for *confident wrongness* — the single worst property a local tier can have.

So the calibration prompts got expected answers attached:

```js
{
    tier: 'easy',
    prompt: 'What is the chemical symbol for water?',
    expect: ['h2o', 'h₂o'],
},
```

Now every candidate is scored on the joint outcome — what the router would actually *do* with it, and whether that was right:

| Outcome | Meaning |
|---|---|
| **local-ok** | Kept local **and** right. The whole point. |
| **local-BAD** | Kept local **and** wrong. A fabrication presented as fact. |
| **escalated** | Sent to the frontier tier. Costs tokens, never wrong. |

Fewest **local-BAD** wins; **local-ok** is the tie-break. Same asymmetry as Day 5's threshold sweep, applied to model choice.

One fairness detail: the *computable* hard prompts — the train problem, a tank filling and draining, a Markov chain's stationary distribution — got expected answers too, worked out by hand. Without that, a model clever enough to actually solve one would be marked wrong for answering locally, punished by an assumption instead of measured.

## Second: reasoning models hide their answer

Before any scoring, a discovery that would have quietly rigged the whole comparison.

Newer models — the qwen3 family, `phi-4-reasoning`, `deepseek-r1` — do chain-of-thought reasoning inline, in the same response string:

```
<think>
Okay, the user is asking for the capital of France. Let me recall... I should
double-check that this is correct. Since I'm a language model, I don't have
the ability to verify information, but I know that the capital of France is
Paris. So, the answer should be Paris.
</think>

Paris.
```

That reasoning block is long, free-form, and varies **enormously** between samples — far more than the answer does. Feed it into my agreement metric and it swamps the signal completely. Exactly the Day 4 waffle problem, with a much bigger hammer.

Which means: without stripping it, my benchmark would have **penalised reasoning models for reasoning.** The comparison would have been rigged before it started, and the results would have looked perfectly plausible.

```js
export function stripThinking(text) {
    return text
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<think>[\s\S]*$/i, '')
        .trim();
}
```

I also had to raise the token limit from 512 to 1024, because these models spend most of their budget thinking before writing a word of answer. Too low a cap truncates them mid-thought — and my scorer correctly disqualifies truncated samples, which would have measured *the cap* rather than the model.

## The results

Five candidates, twenty prompts, three samples each:

```
  model              easy   hard    gap  thresh   local-ok  local-BAD   latency  tokens
  qwen2.5-0.5b       0.94   0.29  -0.09   0.76        9/20         0     16.2s     567
  qwen3-0.6b         0.97   0.24  -0.33   0.65        9/20         2     41.0s    1316
  phi-3.5-mini       1.00   0.90  + 0.00   0.50       11/20         8     66.0s     555
  qwen3.5-0.8b       1.00   0.90  + 0.00   0.50       10/20         9     12.5s     519
  qwen2.5-1.5b       1.00   1.00  + 0.00   0.50        9/20        11      5.7s     280
```

Read the `local-BAD` column. My original 0.5B pick has **zero** wrong answers kept local. The bigger, newer models have eight, nine, eleven.

That's backwards. Bigger models are *better* at answering questions. How are they dramatically worse here?

## The thing that was actually happening

Look at `qwen2.5-1.5b`: easy agreement **1.00**, hard agreement **1.00**.

Perfect agreement on *hard* prompts. On unknowable trivia. That would mean producing the identical fabrication three times running.

That's not a model being confident. That's a model not sampling at all. I printed the raw drafts:

```
--- qwen2.5-1.5b :: What was the exact GDP per capita of Botswana in 1987?
  [1] $2065.43
  [2] $2065.43
  [3] $2065.43
  identical across samples: true
```

Byte-identical. So I pushed on the settings — turned temperature up to **1.5**, added top-p 0.95, removed the seed entirely:

```
temp0.7 + seeds 11/22/33     distinct=1/3   "$2065.43"
temp0.7 + NO seed            distinct=1/3   "$2065.43"
temp1.5 + NO seed            distinct=1/3   "$2065.43"
temp1.5 + topP 0.95          distinct=1/3   "$2065.43"
```

**Temperature has no effect on this model.** Foundry Local decodes it greedily and ignores the setting entirely. Across all five candidates:

| model | distinct samples | usable |
|---|---|---|
| `qwen2.5-0.5b` | 3/3 | ✅ |
| `qwen3-0.6b` | 3/3 | ✅ |
| `qwen3.5-0.8b` | 1/3 | ❌ greedy |
| `qwen2.5-1.5b` | 1/3 | ❌ greedy |
| `phi-3.5-mini` | 1/3 | ❌ greedy |

**Three of five models cannot be used with this technique at all.**

This is the temperature-0 catastrophe from Day 3 — every sample identical, agreement pinned at 1.0, nothing ever escalating — happening at temperature 0.7 through no fault of my configuration. And it is completely silent. Nothing errors. The router just quietly becomes "always answer locally", and the local tier starts presenting fabrications as fact with a reassuring `agreement 1.00` beside them.

Their terrible scores were never measuring model quality. They were measuring **the runtime's decoding strategy**.

That's now a precondition check that runs before any scoring — three calls, and a greedy model is eliminated before you spend an hour benchmarking it:

```
⚠ decodes greedily — ignores temperature, so self-consistency cannot measure it
```

Flagged models rank last regardless of score, because their numbers describe the runtime rather than the model.

**The habit that saved this:** a counterintuitive result is a reason to test your instrument, not a finding to publish. "Bigger models are worse at knowing what they don't know" is a spicy headline. It was also completely false, and I was three edits from writing it down as a conclusion.

## The recommendation

Between the two models the metric can actually measure, it isn't close:

**`qwen2.5-0.5b` at threshold 0.76.** Same 9/20 answered locally and correctly as qwen3-0.6b, but **zero** wrong answers kept local against its two — at 2.5× the speed and 2.3× fewer tokens, since qwen3-0.6b burns most of its budget inside `<think>`.

My convenience pick from Day 1 survived. Not because I chose well, but because most of the alternatives are disqualified by a runtime property nobody documents.

## The uncomfortable conclusion

There's a pattern in that results table I can't unsee.

The models with high, undifferentiated agreement are the ones the metric fails on. The model where it works best is the **smallest and least capable one**. And that's not a coincidence:

**This technique works here partly *because* the model is weak enough to be erratic.**

A small model that doesn't know something genuinely flounders — three samples, three different guesses, low agreement, escalate. A more capable and more self-consistent model produces the *same* confident answer every time whether or not it's correct. The signal degrades exactly as the model improves.

Self-consistency is a confidence measure for models that are genuinely uncertain. It is **not** a general-purpose correctness oracle, and "just use a bigger local model" is not the upgrade path it appears to be. The benchmark says the opposite of what intuition says.

## What seven days actually taught me

Looking back, the code was never the hard part. The whole tool is a few hundred lines. Every difficulty was epistemic — knowing whether the thing I built did what I believed it did.

Five habits earned their keep:

1. **Probe the runtime, don't read the docs.** Logprobs are declared in the type definitions and never populated. Temperature is a documented parameter that three of five models ignore. Both facts only exist if you go looking.
2. **Build the labelled set first.** Twenty prompts, twenty minutes. Caught two bugs that would have silently degraded every routing decision the tool ever made.
3. **An error code is only evidence if a control produces a different one.** A 401 that "proved" my request was valid proved nothing; so did a 400.
4. **Never fold a degraded path into the success bucket.** A fallback fires on the hard cases by construction, so counting it as success biases the metric using exactly the data that disproves it.
5. **A surprising result means test the instrument.** Bigger models scoring worse was the symptom of greedy decoding — an instrument fault dressed up as a finding.

None of these are about LLMs specifically. They're about building systems whose output is a *judgement* rather than a value, where "it ran without erroring" tells you almost nothing about whether it worked.

That's the part I'd want to keep if I built this again.

---

Thanks for reading all seven. The whole thing — code, calibration set, benchmark harness, and a `CLAUDE.md` documenting every gotcha in this series — is at **[github.com/appwiz/foundry-first](https://github.com/appwiz/foundry-first)**.

*Previous: [Day 6 — Calling in the expert, and counting the savings honestly](day-6-escalation-and-honest-metrics.md)*
*Start over: [Day 1 — An LLM on your laptop in 40 lines](day-1-llm-on-your-laptop.md)*
