/*
 * foundry-first — local-first LLM routing with frontier escalation.
 * Copyright (C) 2026 Rohan Deshpande
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { loadLocalModel, sampleLocal, selectRepresentative } from './lib/local.js';
import { scoreSamples, shouldEscalate } from './lib/confidence.js';
import { escalate, credentialHint, FRONTIER_MODEL } from './lib/frontier.js';
import * as metrics from './lib/metrics.js';
import { CALIBRATION_SET } from './lib/calibration.js';
import { compareModels, formatComparison } from './lib/compare.js';

const CONFIG = {
    appName: 'my-app',
    // Benchmarked against qwen3-0.6b, qwen3.5-0.8b, qwen2.5-1.5b and
    // phi-3.5-mini via `--compare`. It wins for a non-obvious reason: most
    // catalog models decode greedily under Foundry Local regardless of
    // temperature, which makes every sample identical and self-consistency
    // unusable. See the Choosing the local model section of README.md.
    modelAlias: 'qwen2.5-0.5b',
    sampleCount: 3,
    // Must be non-zero. At temperature 0 the model is deterministic, every
    // sample is identical, and agreement is a constant 1.0 that measures
    // nothing. See lib/confidence.js.
    temperature: 0.7,
    // Generous because reasoning models (qwen3, phi-4-reasoning) spend most of
    // their budget inside <think> before writing a word of the answer. Too low
    // a cap truncates them mid-thought, which the scorer correctly disqualifies
    // — but that would measure the cap, not the model.
    localMaxTokens: 1024,
    // Load-bearing for the metric, not a style preference. Left unconstrained,
    // this model wraps a stable answer in unstable prose — three samples all
    // saying "H2O" scored 0.307 because the surrounding explanation differed
    // every time. Suppressing the padding makes agreement measure the answer
    // rather than the phrasing. See the Calibration section of README.md.
    localSystemPrompt:
        'Answer directly and concisely. State only the answer itself. '
        + 'Do not explain your reasoning, restate the question, or add caveats unless explicitly asked.',
    frontierMaxTokens: 64000,
    // Measured, not chosen. `--compare` sweeps thresholds against the labelled
    // set scoring *correctness*, minimising wrong answers kept local before
    // maximising right ones, and takes the midpoint of the widest viable band
    // so the cut survives run-to-run noise. On qwen2.5-0.5b that is 0.76:
    // 9/20 answered locally and correctly, 0 wrong answers kept local.
    // Re-run --compare after changing the model, sample count, or temperature.
    threshold: 0.76,
};

function parseArgs(argv) {
    const opts = { prompt: [], stats: false, calibrate: false, resetStats: false, localOnly: false, verbose: false, compare: null };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        switch (arg) {
            case '--stats': opts.stats = true; break;
            case '--calibrate': opts.calibrate = true; break;
            case '--reset-stats': opts.resetStats = true; break;
            case '--local-only': opts.localOnly = true; break;
            case '--verbose': case '-v': opts.verbose = true; break;
            case '--threshold': CONFIG.threshold = Number(argv[++i]); break;
            case '--samples': CONFIG.sampleCount = Number(argv[++i]); break;
            case '--model': CONFIG.modelAlias = argv[++i]; break;
            case '--compare': opts.compare = (argv[++i] ?? '').split(',').filter(Boolean); break;
            default: opts.prompt.push(arg);
        }
    }
    opts.prompt = opts.prompt.join(' ');
    return opts;
}

const USAGE = `Usage: node index.js [options] "<prompt>"

Answers locally when the local model is confident, escalating to ${FRONTIER_MODEL}
when it is not. Confidence is measured by self-consistency across independently
seeded samples — see README.md.

Options:
  --local-only        Never escalate; report what would have happened
  --samples <n>       Samples drawn to measure agreement (default ${CONFIG.sampleCount})
  --threshold <0-1>   Agreement below this escalates (default ${CONFIG.threshold})
  --verbose, -v       Show per-sample drafts and the agreement score
  --model <alias>     Local model to use (default ${CONFIG.modelAlias})
  --stats             Print cumulative routing metrics and exit
  --reset-stats       Clear cumulative metrics and exit
  --calibrate         Measure agreement across a labelled prompt set and exit
  --compare a,b,c     Benchmark candidate local models against that set and exit`;

function log(verbose, message) {
    if (verbose) {
        console.error(message);
    }
}

/** Run the labelled calibration set and report where the threshold should sit. */
async function runCalibration(model) {
    console.log(`Calibrating on ${CALIBRATION_SET.length} prompts, ${CONFIG.sampleCount} samples each...\n`);
    const rows = [];

    for (const item of CALIBRATION_SET) {
        const { samples } = await sampleLocal(model, item.prompt, CONFIG);
        const score = scoreSamples(samples);
        rows.push({ ...item, agreement: score.agreement, disqualified: score.disqualifiers.length > 0 });
        const flag = score.disqualifiers.length > 0 ? ' [disqualified]' : '';
        console.log(`  ${score.agreement.toFixed(3)}  ${item.tier.padEnd(9)} ${item.prompt.slice(0, 52)}${flag}`);
    }

    const easy = rows.filter((r) => r.tier === 'easy').map((r) => r.agreement);
    const hard = rows.filter((r) => r.tier === 'hard').map((r) => r.agreement);
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const min = (xs) => Math.min(...xs);
    const max = (xs) => Math.max(...xs);

    console.log(`\n  easy  n=${easy.length}  mean ${mean(easy).toFixed(3)}  min ${min(easy).toFixed(3)}`);
    console.log(`  hard  n=${hard.length}  mean ${mean(hard).toFixed(3)}  max ${max(hard).toFixed(3)}`);

    const gap = min(easy) - max(hard);
    console.log(`\n  separation gap ${gap.toFixed(3)}`);

    // Sweep candidate thresholds rather than taking the midpoint of the gap.
    // Midpoint is only optimal when the classes separate cleanly; where they
    // overlap it is just a point inside the overlap with no claim to
    // minimising error, and can sit well away from the best cut.
    let bestT = 0;
    let bestErrors = Infinity;
    let bestConfusion = null;
    for (let t = 0; t <= 1.0001; t += 0.01) {
        // Matches shouldEscalate: escalate when agreement < threshold.
        const easyEscalated = rows.filter((r) => r.tier === 'easy' && r.agreement < t).length;
        const hardKeptLocal = rows.filter((r) => r.tier === 'hard' && r.agreement >= t).length;
        const errors = easyEscalated + hardKeptLocal;
        if (errors < bestErrors) {
            bestErrors = errors;
            bestT = t;
            bestConfusion = { easyEscalated, hardKeptLocal };
        }
    }

    if (gap > 0) {
        console.log('  classes separate cleanly.');
    } else {
        console.log('  classes overlap — no threshold separates them perfectly on this set.');
    }
    console.log(`  best threshold ${bestT.toFixed(2)} — ${rows.length - bestErrors}/${rows.length} correctly routed`);
    console.log(`    ${bestConfusion.easyEscalated} easy escalated unnecessarily (costs tokens)`);
    console.log(`    ${bestConfusion.hardKeptLocal} hard kept local (risks a confident wrong answer)`);
    console.log('\n  Those two errors are not equally bad: an unnecessary escalation costs');
    console.log('  tokens, while a hard question kept local surfaces a fabrication as fact.');
    console.log('  Round the threshold up when in doubt.');
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));

    if (opts.resetStats) {
        metrics.save(CONFIG.appName, metrics.empty());
        console.log(`Metrics cleared: ${metrics.metricsPath(CONFIG.appName)}`);
        return;
    }

    if (opts.stats) {
        console.log(metrics.format(metrics.summarize(metrics.load(CONFIG.appName))));
        console.log(`\n  ${metrics.metricsPath(CONFIG.appName)}`);
        return;
    }

    // Comparison loads each candidate itself, so it runs before the single
    // model below is resolved.
    if (opts.compare) {
        const results = await compareModels(opts.compare, CONFIG, CONFIG.appName);
        console.log(formatComparison(results));
        return;
    }

    if (!opts.prompt && !opts.calibrate) {
        console.error(USAGE);
        process.exit(1);
    }

    // ---- Local tier -------------------------------------------------------
    const { model } = await loadLocalModel({
        appName: CONFIG.appName,
        alias: CONFIG.modelAlias,
        onDownloadProgress: (p) => process.stdout.write(`\rDownloading model... ${p.toFixed(1)}%`),
    });

    try {
        if (opts.calibrate) {
            await runCalibration(model);
            return;
        }

        const { samples, latencyMs, localTokens } = await sampleLocal(model, opts.prompt, CONFIG);
        const score = scoreSamples(samples);
        const decision = shouldEscalate(score, CONFIG.threshold);

        if (opts.verbose) {
            samples.forEach((s, i) => {
                log(true, `  [draft ${i + 1}] (${s.finishReason}) ${s.text.trim().replace(/\s+/g, ' ').slice(0, 110)}`);
            });
            log(true, `  agreement ${score.agreement.toFixed(3)} vs threshold ${CONFIG.threshold} — ${decision.escalate ? 'ESCALATE' : 'LOCAL'}\n`);
        }

        let entry = { localTokens, localLatencyMs: latencyMs, escalated: false };

        if (!decision.escalate) {
            console.log(selectRepresentative(samples).text.trim());
            console.error(`\n[local · agreement ${score.agreement.toFixed(2)} · ${latencyMs}ms · 0 frontier tokens]`);
        } else if (opts.localOnly) {
            console.log(selectRepresentative(samples).text.trim());
            console.error(`\n[local-only · would have escalated: ${decision.reason}]`);
        } else {
            // The frontier tier can fail for reasons outside our control —
            // absent credentials, network, rate limits. None of those should
            // cost the user the answer we already have in hand, so degrade to
            // the local draft rather than exiting empty-handed.
            try {
                entry = await runEscalation(opts, samples, decision, entry);
            } catch (err) {
                entry.escalationFailed = true;
                console.log(selectRepresentative(samples).text.trim());
                console.error(`\n[local fallback · escalation needed (${decision.reason}) but unavailable]`);
                console.error(`  ${err.message.split('\n')[0]}`);
                if (!credentialHint()) {
                    console.error('  Set ANTHROPIC_API_KEY, or run `ant auth login`, to enable the frontier tier.');
                }
            }
        }

        const updated = metrics.record(metrics.load(CONFIG.appName), entry);
        metrics.save(CONFIG.appName, updated);
    } finally {
        await model.unload();
    }
}

async function runEscalation(opts, samples, decision, entry) {
    console.error(`[escalating to ${FRONTIER_MODEL} — ${decision.reason}]\n`);
    const result = await escalate(opts.prompt, samples, decision.reason, {
        onText: (delta) => process.stdout.write(delta),
        maxTokens: CONFIG.frontierMaxTokens,
    });
    process.stdout.write('\n');

    if (result.refused) {
        console.error(`\n[frontier declined the request${result.refusalCategory ? ` (${result.refusalCategory})` : ''}]`);
    } else {
        console.error(`\n[frontier · ${result.servedBy} · ${result.latencyMs}ms · ${result.inputTokens + result.outputTokens} tokens]`);
    }

    return {
        ...entry,
        escalated: true,
        refused: result.refused,
        remoteInputTokens: result.inputTokens,
        remoteOutputTokens: result.outputTokens,
        remoteLatencyMs: result.latencyMs,
    };
}

await main();
