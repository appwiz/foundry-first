# Publishing kit — "Local First" series

A seven-part series on building [foundry-first](https://github.com/appwiz/foundry-first): a CLI that answers with a small on-device model and escalates to a frontier model only when the local model is measurably unsure.

One article per day, each with a LinkedIn post to drive readers to it.

## The series

| Day | Article | The hook |
|---|---|---|
| 1 | [An LLM on your laptop in 40 lines](articles/day-1-llm-on-your-laptop.md) | It runs *inside* your process — no server, no API key |
| 2 | [Why route between two models at all](articles/day-2-why-route.md) | Small models are free and often wrong; frontier models are neither |
| 3 | [Asking a model how sure it is — without asking it](articles/day-3-measuring-confidence.md) | The textbook signal didn't exist, so I had to measure it differently |
| 4 | [My confidence metric was measuring the wrong thing. Twice.](articles/day-4-metric-was-wrong.md) | Three samples all said "H2O" and scored 0.307 |
| 5 | [Picking a threshold is not a vibe](articles/day-5-picking-a-threshold.md) | My first threshold picker used maths that only works when the answer is easy |
| 6 | [Calling in the expert, and counting the savings honestly](articles/day-6-escalation-and-honest-metrics.md) | My metrics counted failures as successes |
| 7 | [I benchmarked five local models. Three couldn't be used at all.](articles/day-7-benchmarking-models.md) | The bigger models scored worse — and the reason wasn't the models |

## Suggested schedule

Weekday mornings, 8–10am in your audience's timezone, one per day. The series builds, so keep them consecutive — each article ends on the problem the next one solves.

Post the LinkedIn version when the article goes live, not before. Each post is written to stand alone if someone never clicks through.

## Using the LinkedIn posts

Each file in [linkedin/](linkedin/) contains one post. Replace `[LINK]` with the published article URL.

Notes on the format they're written to:
- **The first two lines matter most.** LinkedIn truncates at roughly 140 characters on mobile behind a "…see more". Every post front-loads a concrete claim rather than a preamble.
- **No "I'm excited to share".** Each opens on the finding.
- **Numbers are real.** Every figure quoted comes from a measured run, not an illustration. If you re-run anything and get different numbers, update the posts — they're cited as measurements.
- Hashtags are kept to three or four. Add or drop to taste.

## A note on attribution

The repository's commits are co-authored with Claude Opus 5, and the work was done with Claude Code. The articles are written in your voice and don't discuss that either way. If you'd rather be explicit, Day 1 is the natural place for a sentence — readers of this kind of post generally respond well to it being stated plainly.

## Facts and figures used across the series

All measured on Windows 11, x64, CPU inference. Quoted throughout the articles:

| Figure | Value |
|---|---|
| Local model | `qwen2.5-0.5b` (~840 MB of weights) |
| Native runtime libraries | ~46 MB |
| Escalation threshold in use | 0.76 |
| Routing at that threshold | 9/20 answered locally and correctly, 0 wrong kept local |
| Mean agreement, easy vs hard prompts | 0.944 / 0.332 |
| "H2O" agreement before format constraint | 0.307 |
| Easy-prompt mean, before → after format constraint | 0.601 → 0.941 |
| Botswana GDP agreement, words only | 0.778 |
| Models benchmarked | 5 of ~25 in the catalog |
| Models that decode greedily (unusable) | 3 of the 5 |
| A frontier escalation | ~16s, ~1,500 tokens |
