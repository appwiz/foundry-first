# Day 4 — LinkedIn post

**Article:** My confidence metric was measuring the wrong thing. Twice.

---

Three samples all correctly answered "H2O". My confidence metric scored them 0.307 out of 1.0 — near-total disagreement.

The model was certain. My metric said it was guessing.

All three began with the identical sentence: "The chemical symbol for water is H2O." Then each wandered into a completely different essay — one about abundance on Earth, one listing polar-molecule properties, one confidently claiming water has a double bond (it doesn't).

Every answer was right. All the divergence was in the padding *after* the answer.

But my metric compares sets of content words, and those essays contribute dozens of words each with almost no overlap. The one thing they agreed on — "h2o" — was a single token drowning in waffle.

I wasn't measuring whether the model agreed with itself about the answer. I was measuring **whether it agreed with itself about how much to waffle** — and waffle is the highest-variance part of a small model's output.

The fix wasn't a cleverer similarity function. It was to stop generating the noise: one system prompt instructing the model to state only the answer, no explanation.

Mean agreement on questions it knows: **0.601 → 0.941.**

That system prompt reads like a style preference. It is load-bearing for the measurement. It's exactly the kind of line a future reader tidies away, so there's now a comment in the code shouting about it.

Then the second bug, which is nastier.

"What was Botswana's GDP per capita in 1987?" scored 0.778 — high confidence. The model has no idea. What it produced:

[1] "According to the World Bank data... approximately $26,500."
[2] "According to the World Bank's data for 1987... approximately $320."
[3] "According to data from the World Bank... approximately $530."

Three fabrications spanning two orders of magnitude, each citing the World Bank, in almost the same sentence. The shared scaffolding carried the score; the only thing that differed — the number, which is the entire answer — got drowned out.

Bug one made a good answer look uncertain. Bug two makes a **fabrication look certain**. Much worse.

Fix: when samples quote numbers, the score is capped by how much those numbers agree. A disagreement of fact can't be papered over by agreement of phrasing.

Both bugs were invisible from reading the code. The code did exactly what I wrote. What I wrote wasn't what I meant, and the only thing that surfaced it was running against data where I already knew the right answer.

The labelled set took twenty minutes to write and caught two bugs that would have silently degraded every routing decision the tool ever made.

If you're building anything whose output is a judgement rather than a value: build the labelled set first.

Day 4 of 7: [LINK]

#MachineLearning #SoftwareEngineering #Testing #AI
