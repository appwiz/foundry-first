# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A CLI that answers with a local LLM (in-process via Microsoft Foundry Local) and escalates to `claude-opus-5` when the local model is measurably unsure. [README.md](README.md) is comprehensive — it carries the user-facing design doc and developer instructions. This file covers what the README doesn't: the gotchas that required reading `node_modules` install scripts or probing the runtime to establish.

`index.js` is the CLI and routing orchestration; `lib/` holds the local tier, the confidence metric, the frontier tier, metrics, and the calibration set.

## Commands

```bash
npm install                      # fetches ~46MB of native libs via install scripts
node index.js "<prompt>"         # run
node index.js --calibrate        # re-measure the confidence threshold
node index.js --stats            # cumulative routing metrics
node index.js -v --local-only "…" # inspect a routing decision without escalating
```

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

**The local system prompt is load-bearing for the metric, not cosmetic.** Suppressing explanation is what makes agreement measure the answer rather than the phrasing; removing it moved mean agreement on known-easy prompts from 0.941 back down to 0.601 and destroyed class separation. Same for the numeric-agreement rule in `pairAgreement` — without it, confidently-hallucinated figures score 0.778 on shared prose.

**The threshold is calibrated, not chosen.** `--calibrate` scores a labelled easy/hard set and reports the separating point. Re-run it after changing the model, sample count, or temperature — the separation point is a property of the model. The classes currently overlap slightly (gap −0.087); that is a reported finding, not a bug to tune away.

**Frontier tier: `claude-opus-5`, and the request shape is unverified.** No Anthropic credentials were available when the escalation path was written, so it has never completed a real call. It is known to construct and transmit — an invalid key returns 401 from the API — but a control test confirmed auth is checked *before* body validation, so that 401 proves nothing about whether the parameters are accepted. The first real call may surface a 400. Parameters follow the `claude-api` skill: adaptive thinking, streaming, and `fallbacks: "default"` with beta `server-side-fallback-2026-07-01` (note the array form of `fallbacks` uses a *different* header, `-2026-06-01`).

## Conventions

- Source files carry a GPL-3.0-or-later notice header. Keep `package.json`, `package-lock.json`, per-file headers, and `LICENSE` consistent when adding files.
- ESM with top-level `await` (`"type": "module"`). 4-space indent.

## Known constraints

**The `adm-zip` Dependabot alert cannot be cleanly closed.** It is a transitive dependency of the SDK, which pins `^0.5.16` — a caret range on a `0.x` version cannot reach the patched `0.6.0`. Closing it requires an `overrides` block forcing a breaking minor bump on the library that unzips the native runtime, risking the `FoundryLocalCorePath` failure above. Exposure is low: `adm-zip` runs only at install time against Microsoft's HTTPS distribution, never on untrusted runtime input. Prefer waiting for an upstream SDK bump.

**Conditional per-platform dependency selection is unsolved and was left open.** npm skips an `optionalDependencies` entry only when the dependency's own manifest declares a mismatched `os`/`cpu`. Neither SDK package declares those fields, and `overrides` rewrites versions rather than manifests. Listing `foundry-local-sdk-winml` as optional would be actively harmful: `install-winml.cjs` does not bail on non-Windows — it gates only the `Microsoft.Windows.AI.MachineLearning` artifact behind `platform === 'win32'` and force-overwrites the rest on any platform, exiting 0 so npm has no failure to skip on. Verified alternative: the base `foundry-local-sdk` alone installs and runs inference correctly on Windows, resolving the same `qwen2.5-0.5b-instruct-generic-cpu:4` variant, so dropping the WinML variant is a viable one-line simplification that costs the Windows ML execution provider.

## Working agreement

Establish facts from the code first, then give one recommended approach with a brief rationale. Do not present multiple-choice design menus unless the decision is genuinely irreversible — pick a sensible default and proceed.

## Development

Refine the README.md and this file as you learn more and implement changes. Keep the files in sync. Commit code and documentation together. Always push changes with a thoughtful commit message.
