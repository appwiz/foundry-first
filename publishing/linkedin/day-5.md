# Day 5 — LinkedIn post

**Article:** Picking a threshold is not a vibe

---

Every system like this has a magic constant in it somewhere:

    if (confidence < 0.7) escalate();

Where did 0.7 come from? Usually: someone tried a few values, it seemed fine, and it's been there ever since. It gets copied into the next project. Nobody revisits it when the model changes.

I wanted mine to be defensible. It took three attempts.

**Attempt one** was the obvious formula — find the gap between the confident and unconfident groups, split the difference. Clean, symmetric, and only correct when the two groups separate cleanly. Mine overlap, so the "midpoint" was just some point inside the overlap with no claim to being good at anything.

Replacing it with a brute-force sweep of every value from 0.00 to 1.00 immediately did better: 11 of 12 correct, against the formula's 9.

If you're optimising one bounded parameter and can evaluate it cheaply, just sweep it. A closed-form shortcut is only worth it if you've checked its assumptions hold — and mine didn't.

**Attempt two** got the objective wrong. I was counting total mistakes, one for one. But the two ways of being wrong are nothing alike:

→ An easy question escalates unnecessarily: you burn some tokens and two seconds. Annoying.

→ A hard question stays local: the user gets a fabricated legal citation, delivered fluently, with no indication anything is wrong. They believe it.

So the sweep now minimises *wrong answers kept local* first, and only maximises *correct answers kept local* as a tie-break. Encoding the asymmetry in the objective means it's actually enforced, rather than living in a comment.

**Attempt three** came from a unit test. On clean synthetic data the sweep returned a threshold of 0.2000000000000004 — technically perfect, and sitting flush against the nearest wrong answer by a floating-point hair.

These scores aren't stable. It's a stochastic process; the same prompt scores differently between runs. I'd already watched one prompt score 0.587 in calibration and 0.554 in normal use — a swing of 0.03, against a margin of 0.000000004.

Fix: among all thresholds achieving the best outcome, take the midpoint of the widest band. Same classifications, room to breathe on both sides.

Final answer: **0.76**. On the labelled set that's 9 of 20 answered locally and correctly, and **zero** wrong answers kept local.

Zero is the number I care about.

And it's not a constant in a file — it's a command anyone can re-run in a few minutes, because the right threshold is a property of the model, not of my code. A magic number with reproducible provenance stops being magic.

Day 5 of 7: [LINK]

#SoftwareEngineering #MachineLearning #AI #Engineering
