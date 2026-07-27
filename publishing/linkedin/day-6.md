# Day 6 — LinkedIn post

**Article:** Calling in the expert, and counting the savings honestly

---

My routing metrics reported 100% local sufficiency. The system was failing every single escalation.

That's the bug, and I'll come back to it. First, the good part.

When the local model isn't confident, the question goes to a frontier model — and the local drafts go with it, framed as *evidence of what the small model found uncertain, not as authority*. That framing matters: it stops the big model deferring to a confident-sounding fabrication.

It earned its keep immediately. Asked which amendment introduced Iceland's transferable fishing quotas, my local model invented "Article 247-5-1". Three samples, agreement 0.000, escalate.

The frontier model came back with: **none — the premise doesn't hold.** Transferability wasn't added by amendment; it was in the original 1990 Act.

It didn't just answer better — it rejected the question's premise. There was no amendment to find, which is exactly why the small model invented one. That's what models do when a question presupposes something false.

Now the arithmetic, which is where systems like this quietly start lying to their owners.

Token counts are easy — the API's own usage field, exact. The *savings* are the hard part, because a call you didn't make has no cost to measure.

Plenty of dashboards just assume a number: plausible per-call cost × calls avoided, straight onto a slide. That's fiction dressed as measurement.

Instead I price each avoided call at the **measured mean of the escalations that actually happened** — and until one has completed, it reports "n/a" rather than guessing. Estimates carry a ~ and a note; measurements don't.

Which brings me to the bug.

When escalation failed — no credentials, no network — the code printed the local draft as a fallback. Sensible. But the "did we escalate?" flag was still false, so those requests were being counted as **local successes**.

Think about what that does. The router looked at those questions and judged them *too hard for the local tier*. They're the strongest evidence against "the local model handles most things". And the failure path was filing them under "handled locally". The metric improved precisely when the system worked worse.

I found it because I was testing without credentials, so everything failed, and the tool cheerfully reported 100% local sufficiency. A number that good should always feel like a bug.

The general lesson: **whenever a catch block substitutes a lesser result, ask what it does to your numbers.** A fallback fires on the hard cases by construction — folding it into the success bucket doesn't add noise, it biases the metric in the flattering direction using the exact cases that disprove it.

Tomorrow, the finale: I benchmark five local models, and three of them turn out to be unusable for reasons that have nothing to do with how good they are.

Day 6 of 7: [LINK]

#SoftwareEngineering #Observability #AI #MachineLearning
