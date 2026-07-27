# Day 7 — LinkedIn post

**Article:** I benchmarked five local models. Three couldn't be used at all.

---

I benchmarked five local language models. Three of them returned byte-identical text on every sample — at temperature 1.5, with top-p 0.95, and no seed set.

The runtime decodes them greedily and ignores the temperature setting entirely.

That matters here because my whole confidence signal works by sampling a question three times and measuring whether the answers agree. If a model can't sample, agreement is a constant 1.0, nothing ever escalates, and the local tier silently starts presenting fabrications as fact — with a reassuring "agreement 1.00" next to them.

Nothing errors. That's the part that should worry you.

Here's how I nearly published the wrong conclusion instead.

The benchmark said the bigger, newer models were dramatically *worse*. My original 0.5B pick kept zero wrong answers local. The larger ones kept eight, nine, eleven.

"Bigger models are worse at knowing what they don't know" is a spicy headline. I was about three edits from writing it down.

The tell was one number: a 1.5B model scoring **perfect agreement on hard prompts** — on unknowable trivia. That would mean producing the identical fabrication three times running. So I printed the raw samples:

  [1] $2065.43
  [2] $2065.43
  [3] $2065.43

Not confidence. No sampling at all. Their scores were never measuring model quality — they were measuring the runtime's decoding strategy.

**A counterintuitive result is a reason to test your instrument, not a finding to publish.**

Two other things worth passing on:

→ Ranking models by agreement selects for *confident wrongness*. A model reliably wrong in the same way scores a perfect 1.0. Candidates have to be scored against known-correct answers, not just self-consistency.

→ Newer models emit chain-of-thought inline as `<think>...</think>`. That reasoning varies far more between samples than the answer does, so leaving it in swamps the signal — and would have penalised reasoning models *for reasoning*. The comparison would have been rigged before it started, and looked perfectly plausible.

The winner was the model I'd originally picked out of convenience — not because I chose well, but because most alternatives are disqualified by an undocumented runtime property.

And the conclusion I can't unsee: **this technique works partly because the model is weak enough to be erratic.** A model that doesn't know something genuinely flounders — three guesses, low agreement, escalate. A more capable, more self-consistent model gives the same confident answer every time, right or wrong. The signal degrades as the model improves.

Self-consistency measures uncertainty, not correctness. "Just use a bigger local model" is not the upgrade path it looks like.

That's the series. The code was never the hard part — the difficulty was knowing whether what I built did what I believed.

Day 7 of 7: [LINK]

Code and benchmark harness: github.com/appwiz/foundry-first

#MachineLearning #SoftwareEngineering #LocalLLM
