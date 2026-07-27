# Day 2 — LinkedIn post

**Article:** Why route between two models at all

---

Sending every question to a frontier model means paying frontier prices for "what is 7 times 8".

Sending every question to a small local model means shipping confident fabrications to your users.

Most teams pick one column and live with the downside. I don't think either is the right default — because the right default isn't a column, it's per-question.

Think about what you actually ask an assistant over a day. Syntax lookups, conversions, "what does this error mean". A small model handles most of that fine, in under a second, for nothing, without a single byte leaving the machine. A smaller slice genuinely needs reasoning or knowledge the small model doesn't have.

So: answer locally, and escalate only when the local model isn't up to it.

Two things fall out of that design that I like.

The local work isn't wasted when you escalate — the drafts go along as context, so the frontier model builds on whatever the small model got right instead of starting cold.

And failure degrades gracefully. No network, no credentials, rate limited? You still have a local answer in hand. Print it with an honest note rather than erroring out.

The whole design is one flowchart, and one box in it does all the work:

**"is this answer trustworthy?"**

Everything else is plumbing. That box is the product.

And it has a constraint that makes it much harder than it looks: you have to decide *before showing the user anything*. You can't stream the local answer while you think about it — if you stream it and then decide to escalate, you've already committed to an answer you don't trust.

The tempting shortcut is to ask the model to rate its own confidence. One line of code. It's also a self-report from a system that just invented a legal citation, asked whether it invents legal citations.

There's a rigorous way to measure this instead. Tomorrow: what it is, and why it turned out not to be available to me.

Day 2 of 7: [LINK]

#LocalLLM #SoftwareArchitecture #AI #EdgeAI
