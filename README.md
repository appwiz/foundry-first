# foundry-first

A command-line demonstration that **most questions can be answered on-device**, escalating to a frontier model only when the local model is measurably unsure.

A small local model (Qwen2.5-0.5B, running in-process via [Microsoft Foundry Local](https://learn.microsoft.com/azure/ai-foundry/foundry-local/)) answers first. Its confidence is measured objectively. If it clears the bar, the answer is free, private, and offline. If it doesn't, the question escalates to [Claude Opus 5](https://platform.claude.com/docs/en/about-claude/models/overview) — carrying the local drafts along as context, so the work already done is reused rather than discarded.

Every routing decision is recorded, so the value of the local tier is a measurement rather than a claim.

```console
$ node index.js "What is the capital of France?"
Paris
[local · agreement 1.00 · 653ms · 0 frontier tokens]

$ node index.js "Which amendment to the Icelandic fisheries act of 1990 introduced transferable quotas?"
[escalating to claude-opus-5 — agreement 0.000 below threshold 0.760]
**Short answer: none — the premise doesn't hold.** Transferability was not added
later by amendment; it was built into the Fisheries Management Act itself...
[frontier · claude-opus-5 · 16003ms · 1503 tokens]
```

---

## Contents

- [Requirements](#requirements)
- [Quickstart](#quickstart)
- [Design](#design)
  - [Why route at all](#why-route-at-all)
  - [The confidence signal](#the-confidence-signal)
  - [Reasoning models hide their answer](#reasoning-models-hide-their-answer)
  - [Choosing the local model](#choosing-the-local-model)
  - [Calibrating the threshold](#calibrating-the-threshold)
  - [What the metric cannot see](#what-the-metric-cannot-see)
  - [Escalation](#escalation)
  - [Metrics](#metrics)
- [Developing](#developing)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Requirements

| | |
|---|---|
| **OS** | Windows 10/11 on x64. See [Other platforms](#other-platforms). |
| **Node.js** | v18+ for top-level `await` and native ESM. Developed against v24.18.0. |
| **Disk** | ~46 MB of native runtime libraries, plus ~840 MB of model weights. |
| **Network** | First run only, for the local tier. The frontier tier needs network when it fires. |
| **Credentials** | `ANTHROPIC_API_KEY`, or an `ant auth login` profile. **Optional** — without it the local tier still works and escalation degrades gracefully. |

## Quickstart

```bash
git clone https://github.com/appwiz/foundry-first.git
cd foundry-first
npm install
node index.js "Explain the Monty Hall problem in two sentences."
```

The first `npm install` fetches platform-specific native libraries. The first run downloads model weights with a progress bar; later runs start from the local cache.

To enable the frontier tier:

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # or: ant auth login
```

If `ant` is installed under WSL rather than Windows, its profile is invisible to the Windows process — bridge the token across, stripping the trailing CR that would otherwise corrupt the header:

```bash
export ANTHROPIC_AUTH_TOKEN=$(wsl ant auth print-credentials --access-token | tr -d '\r\n')
```

### Options

```
--local-only        Never escalate; report what would have happened
--samples <n>       Samples drawn to measure agreement (default 3)
--threshold <0-1>   Agreement below this escalates
--model <alias>     Local model to use
--verbose, -v       Show per-sample drafts and the agreement score
--stats             Print cumulative routing metrics
--reset-stats       Clear cumulative metrics
--calibrate         Measure agreement across a labelled prompt set
--compare a,b,c     Benchmark candidate local models against that set
```

---

## Design

### Why route at all

A 0.5B-parameter model runs on any laptop CPU, costs nothing per token, and never sends a keystroke off the machine. It is also wrong a great deal of the time. A frontier model inverts every one of those properties.

Neither is the right default. The useful question is not "which model" but "**can this one be trusted with this particular question**" — and answering it requires a confidence signal the router can act on before showing the user anything.

### The confidence signal

The textbook signal is **token-level logprobs**: average the log-probability of each generated token and you have the model's own uncertainty, in nats, for free.

**Foundry Local does not expose them.** Both paths were checked:

| Path | Result |
|---|---|
| FFI chat completions (`completeChat`) | `choices[0].logprobs` is `undefined` — the field is absent entirely |
| HTTP Responses API (`createResponsesClient`) | The field exists on the response but returns `[]`, and `ResponseCreateParams` has no parameter to request it |

So this project uses **self-consistency**, the standard substitute.

The same prompt is sampled K times (default 3) at a fixed non-zero temperature, each with a distinct fixed seed. That draws K independent samples from the model's output distribution. **Agreement between those samples is an empirical estimator of that distribution's entropy** — the same quantity logprobs would have measured directly. A model that knows an answer converges on it; a model that is guessing produces a different guess each time.

This is objective in the sense that matters: it is computed from observed outputs, and never asked of the model. Asking a model to rate its own confidence returns a self-report, which is a different and much weaker thing.

Agreement is the mean pairwise **Szymkiewicz–Simpson overlap coefficient** over content words, with two refinements that calibration forced:

**Numeric disagreement is decisive.** Word overlap alone is too forgiving on quantitative questions — asked for a figure it doesn't know, the model emits the same confident sentence with a different number each time, and the shared prose carries the score. "GDP per capita of Botswana in 1987" scored **0.778 on words alone** while every sample named a different figure. So when samples quote numbers, the pair scores no higher than the agreement between those numbers: a disagreement of fact cannot be papered over by agreement of phrasing.

**Output is format-constrained.** This is load-bearing for the metric, not a style preference. Left to ramble, the model wraps a stable answer in unstable prose — three samples all correctly saying `H2O` scored **0.307**, because the surrounding explanation differed every time. A system prompt suppressing explanation makes agreement measure the answer rather than the phrasing. That single change moved the mean agreement on known-easy prompts from **0.601 to 0.941**.

Two objective facts about the generation bypass the score entirely and force escalation, because they make agreement meaningless:

- **`finish_reason === 'length'`** — the sample was cut off mid-answer, so agreement between fragments proves nothing.
- **A sample with no content words** — nothing to agree about.

### Reasoning models hide their answer

The qwen3 and qwen3.5 families, `phi-4-reasoning`, and `deepseek-r1` return their chain of thought inline, in the same string as the answer:

```
<think>
Okay, the user is asking for the capital of France. Let me recall... I should
double-check that this is correct. Since I'm a language model, I don't have the
ability to verify information, but I know that the capital of France is Paris.
</think>

Paris.
```

That reasoning is stripped before scoring and before display. It has to be: it is long, free-form, and varies far more between samples than the answer does, so leaving it in would swamp the agreement signal in exactly the way unconstrained prose did — **penalising a reasoning model for reasoning**. It also consumes most of the token budget before the answer starts, which is why the local cap is 1024 rather than 512; a lower cap truncates these models mid-thought, and the scorer then correctly disqualifies a sample that only the cap broke.

### Choosing the local model

Foundry Local's catalog runs from 0.5B to 20B parameters (`foundry model list`), so the default is a measurement rather than a preference. `--compare` runs the labelled set against each candidate:

```bash
node index.js --compare qwen2.5-0.5b,qwen3-0.6b,qwen3.5-0.8b,qwen2.5-1.5b,phi-3.5-mini
```

**Agreement alone cannot rank models.** It measures conviction, and a model reliably wrong in the same way scores a perfect 1.0. Ranking on it would select for confident wrongness. So every calibration prompt carries `expect` — accepted forms of the right answer — and candidates are judged on the joint outcome:

| Outcome | Meaning |
|---|---|
| **local-ok** | Kept local **and** right. The entire point of the local tier. |
| **local-BAD** | Kept local **and** wrong. The failure that matters — a fabrication presented as fact. |
| **escalated** | Sent to the frontier tier. Costs tokens, never wrong. |

Both the threshold sweep and the model ranking minimise **local-BAD** first and maximise **local-ok** only as a tie-break, encoding the asymmetry directly: an unnecessary escalation spends tokens, a wrong local answer misinforms.

The computable `hard` prompts carry `expect` too — worked out by hand — so a model that genuinely *solves* one is credited for answering locally rather than punished by an assumption that small models always fail. The remaining hard prompts are unknowable trivia where keeping the answer local is an error by definition.

#### Most models in the catalog cannot be used at all

Before scoring anything, `--compare` probes whether the runtime actually **samples**. This turns out to be the decisive criterion:

| model | distinct samples | usable |
|---|---|---|
| `qwen2.5-0.5b` | 3/3 | ✅ |
| `qwen3-0.6b` | 3/3 | ✅ |
| `qwen3.5-0.8b` | 1/3 | ❌ greedy |
| `qwen2.5-1.5b` | 1/3 | ❌ greedy |
| `phi-3.5-mini` | 1/3 | ❌ greedy |

Three of the five return **byte-identical text on every sample** — at temperature 1.5, with top-p 0.95, and with no seed set. Foundry Local decodes them greedily and ignores the temperature setting entirely:

```console
$ node index.js --compare qwen2.5-1.5b
  ⚠ decodes greedily — ignores temperature, so self-consistency cannot measure it
  [1] $2065.43     [2] $2065.43     [3] $2065.43
```

For those models agreement is a constant 1.0, nothing ever clears the escalation bar, and **the router silently degrades into "always answer locally"** — the failure documented for temperature 0, occurring here at temperature 0.7 through no fault of the configuration. It is silent because nothing errors: the local tier just quietly starts presenting fabrications as fact.

This is what actually produced their terrible scores in the table below. Their `local-BAD` columns measure the runtime's decoding, not the model's judgement, so they are ranked last regardless of score and flagged `⚠`.

#### Results

```
  model              easy   hard    gap  thresh   local-ok  local-BAD  escalated   latency  tokens
  qwen2.5-0.5b       0.94   0.29  -0.09   0.76        9/20         0         11     16.2s     567
  qwen3-0.6b         0.97   0.24  -0.33   0.65        9/20         2          9     41.0s    1316
  phi-3.5-mini  ⚠    1.00   0.90  + 0.00   0.50       11/20         8          1     66.0s     555
  qwen3.5-0.8b  ⚠    1.00   0.90  + 0.00   0.50       10/20         9          1     12.5s     519
  qwen2.5-1.5b  ⚠    1.00   1.00  + 0.00   0.50        9/20        11          0      5.7s     280
```

Between the two usable candidates, **`qwen2.5-0.5b` at threshold 0.76** wins on every axis: the same 9/20 answered locally and correctly, but **zero** wrong answers kept local against qwen3-0.6b's two, at 2.5× the speed and 2.3× fewer tokens (qwen3-0.6b spends most of its budget inside `<think>`).

The uncomfortable implication is worth stating: this technique works here *because* the model is weak enough to be erratic. A more capable, more self-consistent model agrees with itself even when fabricating, and the signal degrades. Self-consistency is a confidence measure for models that are genuinely uncertain — not a general-purpose correctness oracle.

### Calibrating the threshold

The threshold is not a guess. `lib/calibration.js` holds twenty prompts labelled in two classes — ten `easy` (well within a 0.5B model's competence; *should* stay local) and ten `hard` (obscure specifics and multi-step reasoning; *should* escalate). `--calibrate` scores every prompt and reports where the classes separate:

```console
$ node index.js --calibrate
  1.000  easy      What is the chemical symbol for water?
  0.944  easy      Who wrote the play Romeo and Juliet?
  0.500  easy      Name the largest ocean on Earth.
  0.572  hard      A train leaves at 14:23 travelling 87 km/h and anoth...
  0.470  hard      Derive the stationary distribution of a three-state...
  0.000  hard      Which specific amendment to the Icelandic fisheries...

  easy  n=10  mean 0.944  min 0.500
  hard  n=10  mean 0.332  max 0.587

  separation gap -0.087
  classes overlap — no threshold separates them perfectly on this set.
  best threshold 0.59 — 19/20 correctly routed
    1 easy escalated unnecessarily (costs tokens)
    0 hard kept local (risks a confident wrong answer)
```

The two classes separate cleanly in the mean — **0.944 easy against 0.332 hard** — which is the signal the router runs on.

`--calibrate` and `--compare` optimise different objectives and will disagree, which is intended. `--calibrate` scores against the *labels* (did an `easy` prompt stay local?) and suggests 0.59. `--compare` scores against *correctness* (was the answer kept local actually right?) and suggests 0.76. **`--compare` is authoritative**, because a label only asserts a prompt *should* be answerable, whereas correctness checks whether this model actually answered it.

The threshold is found by **sweeping** candidate values and counting misclassifications, not by taking the midpoint between the classes — midpoint is only optimal when they separate cleanly, and here they overlap.

The sweep also takes the **midpoint of the widest viable band** rather than the lowest value that happens to work. Agreement varies between runs — one prompt measured 0.587 during calibration and 0.554 in normal use — so a threshold sitting flush against the nearest wrong answer does not survive that noise.

The default **0.76** is the value `--compare` produces for `qwen2.5-0.5b` scoring against correctness: 9/20 answered locally and correctly, with zero wrong answers kept local.

Re-run `--compare` after changing the model, the sample count, or the temperature. The separation point is a property of *the model*, not of the metric.

### What the metric cannot see

The negative separation gap above is a real finding, reported rather than tuned away. Two cases overlap, and each illustrates a genuine limit:

**Confident hallucination reads as confidence.** Asked to name the largest ocean, the model says *Pacific* every time — then volunteers a fabricated statistic, differently each time (196,087,534 km² vs 148,000 km²). Escalating is arguably correct here, but the general point stands: **self-consistency measures conviction, not accuracy**, and a model reliably wrong in the same way scores high. Logprobs share this weakness exactly.

**Agreement on scaffolding is not agreement on substance.** On the train-timing problem, all three samples open with near-identical boilerplate — *"To determine when the trains meet, we need to calculate…"* — and none reaches an answer. The score reflects agreement on how to *start*, and any text-similarity measure inherits this blind spot.

Both are inherent to the approach rather than bugs. A larger labelled set and a task-aware similarity measure would narrow the overlap; neither would eliminate it.

### Escalation

When the local tier falls short, the question goes to **`claude-opus-5`** with the disagreeing local drafts attached as context. The system prompt frames them as evidence of what the small model found uncertain — not as authority — so the frontier model builds on what is right and silently corrects what is not. This is what makes the result a *combined* answer rather than a plain remote one.

The call uses adaptive thinking, streams tokens as they generate, and opts into server-side refusal fallbacks (`fallbacks: "default"`), which re-route a declined request to Anthropic's recommended fallback model rather than returning a refusal.

The reuse is not cosmetic. Asked which amendment introduced Iceland's transferable fishing quotas, the local model confidently invented "Article 247-5-1"; given those drafts as context, the frontier model answered that **no amendment did** — transferability was in the original Act 38/1990 — correcting a false premise embedded in the question itself.

Escalation failure — absent credentials, network, rate limits — never costs the user an answer. The local draft is printed with a clear note, and the request is recorded as a failed escalation rather than a local success.

### Metrics

Cumulative counters persist to `%USERPROFILE%\.my-app\router-metrics.json`.

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

Two properties are worth stating plainly, because savings figures invite overclaiming:

**Savings are counterfactual and labelled as such.** We never made the calls we avoided, so their cost cannot be measured — only estimated. The estimate prices each avoided call at the **measured mean** of the escalations that actually happened. Until at least one escalation completes there is no baseline, and the figures report `n/a` rather than guessing.

**Failed escalations count as neither.** A request the router judged too hard for the local tier, where the frontier tier then failed, is not local sufficiency. Counting it as such would inflate the headline number with exactly the requests that disprove it, so it is tracked separately and excluded from the rate.

Actual frontier token counts come from the API's own `usage` field, and local counts from the SDK's — both exact.

---

## Developing

No build step. Edit and re-run.

```
foundry-first/
├── index.js              # CLI, routing orchestration, calibration harness
├── lib/
│   ├── local.js          # Local sampling, model lifecycle, <think> stripping
│   ├── confidence.js     # Agreement metric and escalation policy
│   ├── frontier.js       # Anthropic escalation
│   ├── metrics.js        # Persistent counters
│   ├── calibration.js    # Labelled prompt set with expected answers
│   └── compare.js        # Model benchmark: stochasticity probe, threshold sweep
└── LICENSE               # GPL-3.0
```

**Tune the routing.** All knobs live in the `CONFIG` object at the top of [`index.js`](index.js): model alias, sample count, temperature, threshold, token limits, and the local system prompt. `--samples` and `--threshold` override the last two per-run.

**Trade cost against sensitivity.** Confidence costs K local inferences per question — the price of an objective metric when logprobs are unavailable. Raising `--samples` sharpens the estimate and slows every request; lowering it to 2 is the cheapest measurement possible, since one sample has nothing to compare against. Changing K changes the threshold, so re-run `--compare` after.

**Swap the local model.** Run `--compare old,new` before committing to one, and change `modelAlias` in `CONFIG` only if the new model is flagged usable. Two things will bite otherwise: most catalog models decode greedily, which makes the router silently stop escalating, and the threshold is a property of the model, so an inherited one will be wrong.

Budget for it — every candidate is downloaded in full (the five-model run pulled ~7 GB into the shared cache, never evicted) and then run through 20 prompts × 3 samples. A greedy model can be ruled out in three calls, so probe before paying for a full evaluation.

**Change the confidence metric.** [`lib/confidence.js`](lib/confidence.js) is self-contained: `scoreSamples` produces the score, `shouldEscalate` applies the policy. If a future SDK release populates `logprobs`, mean log-probability drops in as a replacement for `scoreSamples` with nothing else changing — and would remove the stochasticity requirement, since logprobs are readable from a single greedy sample.

**Do not add streaming to the local answer.** It looks like free responsiveness and silently defeats the router: all K samples must complete before agreement can be scored, and the routing decision has to precede any output. Streaming the first sample commits to a local answer before knowing whether it should escalate. The frontier tier streams because by then the decision is already made.

**Inspect a routing decision.** `--verbose` prints each draft with its finish reason and the resulting score:

```console
$ node index.js -v --local-only "Name the largest ocean on Earth."
  [draft 1] (stop) The largest ocean by area is the Pacific Ocean, which has an estimated 196,087,534 km².
  [draft 2] (stop) The largest ocean by area is the Pacific Ocean, which has an area of approximately 148,000 square kilometers.
  [draft 3] (stop) The largest ocean on Earth is the Pacific Ocean.
  agreement 0.500 vs threshold 0.76 — ESCALATE
```

### Where things live on disk

Paths derive from `appName` (`'my-app'`); changing it moves all of them and orphans the model cache.

| What | Location |
|---|---|
| Model cache | `%USERPROFILE%\.my-app\cache\models` |
| Routing metrics | `%USERPROFILE%\.my-app\router-metrics.json` |
| Logs | `%USERPROFILE%\.my-app\logs` |
| Native libraries | `node_modules/foundry-local-sdk/foundry-local-core/<platform>-<arch>/` |

---

## Troubleshooting

**`FoundryLocalCorePath not specified`**

Native libraries for your platform are missing — usually because `node_modules` was copied from a machine with a different OS or architecture. Reinstall so platform detection re-runs:

```bash
rm -rf node_modules package-lock.json
npm install
```

A correct Windows x64 install has five DLLs under `foundry-local-core/win32-x64/`: `Microsoft.AI.Foundry.Local.Core.dll`, `Microsoft.Windows.AI.MachineLearning.dll`, `onnxruntime.dll`, `onnxruntime-genai.dll`, and `onnxruntime_providers_shared.dll`.

**Nothing ever escalates**

Most likely the local model decodes greedily, making every sample identical and agreement a constant 1.0. Check with `--compare <alias>`, which probes for this before scoring and prints:

```
⚠ decodes greedily — ignores temperature, so self-consistency cannot measure it
```

There is no fix — the technique cannot be used with such a model. Pick one the probe reports as usable. The same symptom appears if `temperature` is set to 0.

**Everything escalates**

The threshold is calibrated for Qwen2.5-0.5B at temperature 0.7 with 3 samples. Change any of those and re-run `--compare`.

**`400 … credit balance is too low`**

Exactly what it says — but note it is returned for *any* request body on an unfunded account, including invalid ones. The billing check runs before body validation, so this error tells you nothing about your parameters. Add credit before debugging the request.

**The import and the dependency have different names**

[`package.json`](package.json) depends on `foundry-local-sdk-winml` while [`index.js`](index.js) imports `foundry-local-sdk`. This is intentional. The `-winml` package ships no API of its own — it is an installer wrapper that declares `foundry-local-sdk` as a dependency and fetches the **WinML** build of the native runtime instead of the standard one. You install the variant; you import the base package.

<a name="other-platforms"></a>
**Other platforms**

Swap the WinML wrapper for the base package, which ships native libraries for non-Windows targets. No change to the source is needed:

```bash
npm uninstall foundry-local-sdk-winml
npm install foundry-local-sdk
```

---

## License

Copyright (C) 2026 Rohan Deshpande

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the [GNU General Public License](LICENSE) for more details.

The Foundry Local SDK and the Anthropic SDK are separate works, distributed by Microsoft and Anthropic respectively under the MIT license.
