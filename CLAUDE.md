# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A CLI that answers with a local LLM (in-process via Microsoft Foundry Local) and escalates to `claude-opus-5` when the local model is measurably unsure. [README.md](README.md) is comprehensive — it carries the user-facing design doc and developer instructions. This file covers what the README doesn't: the gotchas that required reading `node_modules` install scripts or probing the runtime to establish.

`index.js` is the CLI and routing orchestration; `lib/` holds the local tier (`local.js`), the confidence metric (`confidence.js`), the frontier tier (`frontier.js`), metrics (`metrics.js`), the labelled prompt set (`calibration.js`), and the model-comparison harness (`compare.js`).

## Commands

```bash
npm install                      # fetches ~46MB of native libs via install scripts
node index.js "<prompt>"         # run
node index.js --calibrate        # re-measure the confidence threshold
node index.js --compare a,b,c    # benchmark candidate local models (slow: downloads + 3 samples × 20 prompts each)
node index.js --stats            # cumulative routing metrics
node index.js -v --local-only "…" # inspect a routing decision without escalating
```

`foundry model list` shows the full catalog of local candidates. Filter the ANSI codes (`sed 's/\x1b\[[0-9;]*m//g'`) or the table is unreadable.

There is **no build step, no linter, and no test suite**. `npm test` is npm's default placeholder and exits 1 by design. Verification means running the binary with a real prompt and reading the output — a change that "looks right" is not verified until inference actually completes. `--local-only` makes that cheap: it exercises the whole local path and the routing decision without needing credentials or spending frontier tokens.

First run downloads ~840MB of model weights; later runs hit the cache and start in seconds.

## Architecture notes

**In-process FFI, not a client/server.** The SDK loads a native addon into the Node process and calls into `Microsoft.AI.Foundry.Local.Core.dll` → `onnxruntime-genai.dll` → `onnxruntime.dll`. The model occupies this process's memory. There is no port, no base URL, and no daemon to start for chat completions. (An optional HTTP path exists via `manager.startWebService()` + `createResponsesClient(baseUrl)`; this project does not use it.)

**The import name intentionally differs from the dependency name.** `package.json` depends on `foundry-local-sdk-winml`; `index.js` imports `foundry-local-sdk`. This is correct — do not "fix" it. The `-winml` package ships no API of its own; it is an installer wrapper that pulls in `foundry-local-sdk` as a dependency and fetches the WinML build of the native runtime instead of the standard build.

**The two packages coordinate through a filesystem check.** `foundry-local-sdk/script/install-standard.cjs` tests for a sibling `node_modules/foundry-local-sdk-winml/package.json` and `process.exit(0)`s when found, deferring all binary provisioning to `install-winml.cjs`, which writes into the base SDK's directory with `force: true`. Both packages installed together is the intended configuration, not a conflict.

**Native libraries are per-platform and live inside the base SDK.** They land in `node_modules/foundry-local-sdk/foundry-local-core/<platform>-<arch>/`. A WinML `win32-x64` install has 5 DLLs; the base SDK alone has 4 (no `Microsoft.Windows.AI.MachineLearning.dll`). An empty or wrong-platform directory produces `FoundryLocalCorePath not specified` — fix by deleting `node_modules` and reinstalling so platform detection re-runs, never by hand-copying DLLs.

**`create()` is synchronous by design.** `FoundryLocalManager.create()` returns the manager directly (a singleton) and blocks the event loop during init. Missing `await` is not a bug here. Use `createAsync()` only if this ever becomes a server or GUI.

**Streaming chunks need the optional chaining.** `completeStreamingChat()` yields chunks carrying `choices[0].delta.content` — an increment, not the whole message. That field is **absent** on the first and last chunks, which carry role and finish-reason metadata. Dropping the `if (content)` guard prints `undefined` at both ends of every response.

**Paths derive from `appName`.** `appName: 'my-app'` in the `create()` call determines `%USERPROFILE%\.my-app\` and therefore the model cache, log, and routing-metrics locations. Changing it orphans the existing 840MB cache and forces a re-download.

**Logprobs are unavailable — do not reach for them.** Established by probing both paths, not by reading docs. `completeChat()` omits `choices[0].logprobs` entirely; the HTTP Responses API declares the field on `OutputTextContent` but returns `[]`, and `ResponseCreateParams` has no parameter to request it. The `LogProb` type in `types.d.ts` is therefore a shape the local runtime never populates. This is why confidence is measured by self-consistency instead — if a future SDK release starts populating it, mean log-probability drops straight into `scoreSamples`.

**Temperature must stay non-zero.** At temperature 0 the model is deterministic, every sample is identical, agreement is a constant 1.0, and the confidence signal silently carries no information. Nothing errors — the router just stops escalating.

**Most catalog models decode greedily and ignore temperature entirely — check before adopting one.** This is the single biggest constraint on model choice, and it is invisible until probed. Measured with `probeStochasticity()`: `qwen2.5-1.5b`, `qwen3.5-0.8b`, and `phi-3.5-mini` all return byte-identical text across samples at temperature 1.5 with top-p 0.95 and no seed; `qwen2.5-0.5b` and `qwen3-0.6b` vary 3/3. For a greedy model the failure is exactly the temperature-0 case above, and it is silent: agreement pins at 1.0, nothing escalates, and the local tier starts presenting fabrications as fact. `--compare` probes this first and flags such models `⚠`, ranking them last regardless of score, because their rows describe the runtime's decoding rather than the model. Never adopt a new local model without running that probe.

**The local system prompt is load-bearing for the metric, not cosmetic.** Suppressing explanation is what makes agreement measure the answer rather than the phrasing; removing it moved mean agreement on known-easy prompts from 0.941 back down to 0.601 and destroyed class separation. Same for the numeric-agreement rule in `pairAgreement` — without it, confidently-hallucinated figures score 0.778 on shared prose.

**Reasoning models emit `<think>` inline and it must be stripped.** The qwen3 and qwen3.5 families, `phi-4-reasoning`, and `deepseek-r1` return their chain of thought as `<think>…</think>` before the answer, in the same `content` string. `stripThinking()` in `lib/local.js` removes it before scoring and before display. Without it the reasoning prose — long, free-form, and far more variable between samples than the answer — swamps the agreement signal exactly as unconstrained prose did, so reasoning models would be penalised for reasoning. Their think block also consumes most of `localMaxTokens`, which is why it is set to 1024: a lower cap truncates them mid-thought, and the scorer then correctly disqualifies a sample that only the cap broke.

**Model choice is a `--compare` measurement, not a preference.** `lib/compare.js` runs the labelled set against each candidate and ranks by joint outcome — fewest wrong answers kept local first, then most correct answers kept local. Agreement alone cannot rank models: it measures conviction, and a model reliably wrong in the same way scores perfectly. That is why `CALIBRATION_SET` carries `expect` strings, including on the computable `hard` prompts so a model that genuinely solves one is credited rather than punished.

**The threshold sweep takes the midpoint of the widest viable band, not the lowest working value.** Agreement varies between runs — one prompt measured 0.587 during calibration and 0.554 in normal use — so a threshold sitting flush against the nearest wrong answer does not survive that noise.

**The threshold is calibrated, not chosen.** `--compare` sweeps it against the labelled set scoring correctness; the current 0.76 comes from that run on `qwen2.5-0.5b` (9/20 local-correct, 0 local-wrong). Re-run after changing the model, sample count, or temperature — it is a property of the model. `--calibrate` is the older agreement-only view and still reports a class-separation gap of −0.087; the overlap is a reported finding, not a bug to tune away.

**The metric works here partly *because* the model is weak.** A more capable, more self-consistent model agrees with itself even when fabricating, which is why the larger candidates score so badly rather than so well. Do not assume a bigger local model would improve routing — the benchmark says the opposite.

**The local answer cannot stream, and that is deliberate.** All K samples must finish before agreement can be scored, and the routing decision must precede any output — streaming the first sample would commit to a local answer before knowing whether it should escalate. The frontier tier streams because by then the decision is made. Adding streaming to the local path looks like an easy win and silently defeats the router.

**`--compare` is expensive: budget disk and an hour.** Each candidate is downloaded in full (the five-model run pulled roughly 7 GB) and then run through 20 prompts × 3 samples. Weights land in the shared `%USERPROFILE%\.my-app\cache\models` and are never evicted, so benchmarking a wide shortlist is a lasting disk commitment. Probe stochasticity first — a greedy model can be eliminated in three calls, before paying for a full evaluation.

**Frontier tier: `claude-opus-5` — verified end to end.** A real escalation returns content, so the request shape is confirmed accepted: adaptive thinking, streaming, and `fallbacks: "default"` with beta `server-side-fallback-2026-07-01` (note the array form of `fallbacks` uses a *different* header, `-2026-06-01`). Streaming, `usage` accounting, and metrics recording all work against the live API.

**Testing it from this machine needs the WSL token bridge.** `ant` is installed under WSL, not Windows, so its OAuth profile is invisible to the Windows Node process. Pass it explicitly:

```bash
ANTHROPIC_AUTH_TOKEN=$(wsl ant auth print-credentials --access-token | tr -d '\r\n') node index.js "…"
```

The `tr` matters — WSL emits a trailing CR that corrupts the header. The SDK sets the Bearer header itself; no explicit `oauth-2025-04-20` beta is needed. Tokens are short-lived (~1h), so re-run the substitution rather than caching it.

**A 400 here may say nothing about your request.** The billing check runs *before* body validation: on an account with no credits, a valid body, a bogus beta header, and a `temperature` param that Opus 5 definitively rejects all return the identical `credit balance is too low` error. When debugging a 400, confirm the account has credit before touching the parameters.

## Lessons that cost time

**An error code is only evidence if a control produces a different one.** This bit twice on the frontier tier. A 401 from an invalid key looked like proof the request body was accepted — until a control with a deliberately bogus beta header returned the same 401, showing auth is checked first. Later a 400 looked like a parameter problem, until the same control showed an unfunded account returns that 400 for *any* body. Both times the reasonable-looking inference was worthless. Before concluding anything from a status code, send a request that *should* fail differently and confirm it does.

**Never fold a degraded path into the success bucket.** The metrics counted a failed escalation as local sufficiency, because `entry.escalated` simply stayed `false` when the frontier call threw. That inflates the headline number with precisely the requests that disprove it — the router judged them too hard for the local tier. A fallback fires on the hard cases by construction, so it needs its own outcome (`escalationFailures`, excluded from the rate). Whenever a catch block substitutes a lesser result, ask what it does to the numbers.

**Savings that were never spent are counterfactual — price them from measurement or report `n/a`.** Avoided frontier calls have no measured cost. The estimate prices each at the *measured* mean of escalations that actually completed, and reports `n/a` until at least one has. Do not "improve" this by assuming a token count.

**Optimising a labelled set means sweeping it, not splitting it.** The first threshold picker took the midpoint between class extremes, which is only optimal when the classes separate cleanly. Under overlap it landed on 0.54 and routed 9 of the then-12 prompts correctly; sweeping every candidate value found 0.59 at 11 of 12. When classes overlap, only an explicit sweep over the objective you actually care about finds the optimum.

**Check the harness before believing a surprising ranking.** Larger models scoring dramatically *worse* was the tell that something upstream was broken — and it was: three candidates decode greedily, so their scores measured the runtime rather than the model. A counterintuitive result is a reason to test the instrument, not a finding to report.

## Conventions

- Source files carry a GPL-3.0-or-later notice header. Keep `package.json`, `package-lock.json`, per-file headers, and `LICENSE` consistent when adding files.
- ESM with top-level `await` (`"type": "module"`). 4-space indent.

## Known constraints

**The `adm-zip` Dependabot alert cannot be cleanly closed.** It is a transitive dependency of the SDK, which pins `^0.5.16` — a caret range on a `0.x` version cannot reach the patched `0.6.0`. Closing it requires an `overrides` block forcing a breaking minor bump on the library that unzips the native runtime, risking the `FoundryLocalCorePath` failure above. Exposure is low: `adm-zip` runs only at install time against Microsoft's HTTPS distribution, never on untrusted runtime input. Prefer waiting for an upstream SDK bump.

**Conditional per-platform dependency selection is unsolved and was left open.** npm skips an `optionalDependencies` entry only when the dependency's own manifest declares a mismatched `os`/`cpu`. Neither SDK package declares those fields, and `overrides` rewrites versions rather than manifests. Listing `foundry-local-sdk-winml` as optional would be actively harmful: `install-winml.cjs` does not bail on non-Windows — it gates only the `Microsoft.Windows.AI.MachineLearning` artifact behind `platform === 'win32'` and force-overwrites the rest on any platform, exiting 0 so npm has no failure to skip on. Verified alternative: the base `foundry-local-sdk` alone installs and runs inference correctly on Windows, resolving the same `qwen2.5-0.5b-instruct-generic-cpu:4` variant, so dropping the WinML variant is a viable one-line simplification that costs the Windows ML execution provider.

## State of play

Both tiers are verified end to end against real inference and a real API call. What follows is the resumable picture: measured baselines to compare a re-run against, and the threads left open.

**Verified working.** Local sampling, `<think>` stripping, the agreement metric, the threshold sweep, escalation to `claude-opus-5` (real response, exact `usage`), streaming, graceful degradation when the frontier tier is unreachable, and metrics with a populated counterfactual baseline.

**Current measured baselines** (qwen2.5-0.5b, temperature 0.7, 3 samples, 20-prompt set). Re-derive with `--compare` and `--calibrate` after any change to model, sample count, or temperature:

| Measurement | Value |
|---|---|
| Threshold in use | 0.76 (from `--compare`, correctness-scored) |
| Routing at that threshold | 9/20 local-correct, **0** local-wrong, 11 escalated |
| Agreement, easy vs hard | 0.944 / 0.332 — separation gap −0.087 |
| Label-scored threshold | 0.59, 19/20 (`--calibrate`; superseded by `--compare`) |
| Frontier call | ~16s, ~1.5k tokens for a substantive answer |

**Open threads, roughly by value:**

1. **Only 5 of ~25 chat models in the catalog were benchmarked** — `qwen2.5-0.5b`, `qwen3-0.6b`, `qwen3.5-0.8b`, `qwen2.5-1.5b`, `phi-3.5-mini`. Untested and plausible: `smollm3-3b`, `qwen3.5-2b-text`, `qwen3-1.7b`, `ministral-3-3b`, `phi-4-mini`. Probe stochasticity first — three of five tested so far were greedy, so screening is cheap and eliminates most candidates before a full run.
2. **The 20-prompt calibration set is small**, and the −0.087 class overlap is partly a small-sample artifact. Widening it would firm up the threshold and is the cheapest credibility win available.
3. **`--calibrate` and `--compare` implement two different sweeps.** `--calibrate` scores against labels, `--compare` against correctness. Keeping both is defensible (they answer different questions) but the duplication invites drift; folding `--calibrate` into a view over `--compare` data would remove it.
4. **The metric's blind spots are documented, not fixed** — confident hallucination reads as confidence, and agreement on reasoning scaffolding reads as agreement on substance. A task-aware similarity measure would narrow both.
5. `adm-zip` and conditional per-platform dependencies remain as described under Known constraints — both are blocked upstream rather than unfinished here.

**Not attempted, deliberately.** Multi-turn conversation (the SDK is stateless and the router is single-shot), tool calling, and the HTTP Responses API path.

**To resume on another machine:** clone, `npm install`, then `node index.js --local-only "…"` exercises everything except the frontier tier without credentials. For the frontier tier, export `ANTHROPIC_API_KEY` or run `ant auth login` — the WSL bridge above is only needed where `ant` lives inside WSL rather than on the host. The first run re-downloads ~840MB of weights; `~/.my-app/` is machine-local and nothing in it needs to be carried across.

## Working agreement

Establish facts from the code first, then give one recommended approach with a brief rationale. Do not present multiple-choice design menus unless the decision is genuinely irreversible — pick a sensible default and proceed.

## Development

Refine the README.md and this file as you learn more and implement changes. Keep the files in sync. Commit code and documentation together. Always push changes with a thoughtful commit message.
