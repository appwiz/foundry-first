# Day 3 — LinkedIn post

**Article:** Asking a model how sure it is — without asking it

---

I needed to know how confident a language model was in its answer. There's a textbook way to do this. It didn't exist in my runtime.

When a model generates text it doesn't pick words — at each step it produces a probability distribution over its whole vocabulary and samples from it. That distribution *is* the model's uncertainty. Most APIs hand you those numbers as logprobs. Average them and you have a rigorous confidence score, for free, because the model already computed it.

I went looking for them in Microsoft Foundry Local. Two paths, two dead ends:

→ The in-process chat API has no logprobs field at all. Not empty — absent.

→ The HTTP path *declares* one. There's a LogProb interface right there in the type definitions, with token, logprob and bytes. It returns an empty array, and there's no request parameter anywhere to ask it to be populated.

A well-typed, thoroughly documented dead end.

So, plan B: if I can't read the distribution, I can sample from it.

Ask the same question three times, at non-zero temperature, with different seeds. If the model knows the answer, the distribution is sharp and all three agree. If it's guessing, it guesses differently each time.

Agreement between samples estimates the same quantity logprobs would have told me directly. And crucially it's a **measurement, not a self-report** — I never ask the model anything about its confidence. I compute a number from outputs I observed.

In practice:

"What is the capital of France?" → Paris / Paris / Paris → agreement 1.00 → answer locally

"Which amendment introduced Iceland's transferable fishing quotas?" → the 52nd amendment in 1996 / the Iceland Act of 2005 / the 36th Amendment on July 8, 2015 → agreement 0.00 → escalate

Three different amendments, three different years, each stated with total assurance.

The model never says it's unsure. It demonstrates it by contradicting itself three times running.

One setting silently breaks the whole thing: temperature 0. Generation becomes deterministic, all samples are identical, agreement is a constant 1.00 — for questions it knows cold *and* questions it's fabricating. Nothing errors. The signal just quietly stops containing information.

That's the worst kind of bug: a system that looks like it's working.

Two methodological notes worth stealing: probe the runtime instead of trusting the docs, and never let a system self-report the thing you're trying to measure.

Tomorrow: I point this at labelled data and discover it's been measuring the wrong thing entirely.

Day 3 of 7: [LINK]

#LLM #MachineLearning #SoftwareEngineering #AI
