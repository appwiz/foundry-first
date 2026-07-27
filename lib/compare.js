/*
 * foundry-first — candidate local-model comparison harness.
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

import { loadLocalModel, sampleLocal, selectRepresentative } from './local.js';
import { scoreSamples } from './confidence.js';
import { CALIBRATION_SET, isCorrect } from './calibration.js';

// Picking a local model is not a question of which scores highest on agreement.
// Agreement measures conviction; a model that is reliably wrong in the same way
// every time scores perfectly. What matters for a router is the joint outcome:
//
//   local-correct — kept local AND right. The whole point of the local tier.
//   local-wrong   — kept local AND wrong. The failure that matters, because it
//                   presents a fabrication to the user as fact.
//   escalated     — sent to the frontier tier. Costs tokens, never wrong.
//
// So the threshold sweep minimises local-wrong first and maximises
// local-correct only as a tie-break, and models are ranked the same way.

// A precondition, not a metric. Self-consistency only measures anything if the
// runtime actually samples: identical samples mean agreement is a constant 1.0,
// nothing ever clears the escalation bar, and the router silently degrades into
// "always answer locally" — the exact failure documented for temperature 0,
// except it happens here at temperature 0.7 through no fault of the config.
//
// Measured, not assumed: several Foundry Local models decode greedily and
// ignore temperature entirely. qwen2.5-1.5b and qwen3.5-0.8b return
// byte-identical text at temperature 1.5 with top-p 0.95 and no seed.
const PROBE_PROMPT = 'What was the exact GDP per capita of Botswana in 1987 in US dollars?';

export async function probeStochasticity(model, config) {
    const client = model.createChatClient();
    client.settings.temperature = config.temperature;
    client.settings.maxTokens = 80;

    const seen = new Set();
    for (let i = 0; i < 3; i += 1) {
        client.settings.randomSeed = 11 + i * 11;
        const response = await client.completeChat([
            { role: 'system', content: config.localSystemPrompt },
            { role: 'user', content: PROBE_PROMPT },
        ]);
        seen.add((response.choices?.[0]?.message?.content ?? '').trim());
    }
    return { distinct: seen.size, usable: seen.size > 1 };
}

/** Evaluate every calibration prompt against one already-loaded model. */
async function measureModel(model, config) {
    const rows = [];
    let totalLatency = 0;
    let totalTokens = 0;

    for (const item of CALIBRATION_SET) {
        const { samples, latencyMs, localTokens } = await sampleLocal(model, item.prompt, config);
        const score = scoreSamples(samples);
        const answer = selectRepresentative(samples).text;
        totalLatency += latencyMs;
        totalTokens += localTokens;
        rows.push({
            tier: item.tier,
            agreement: score.disqualifiers.length > 0 ? 0 : score.agreement,
            correct: isCorrect(item, answer),
            latencyMs,
        });
    }

    return {
        rows,
        meanLatencyMs: totalLatency / CALIBRATION_SET.length,
        meanTokens: totalTokens / CALIBRATION_SET.length,
    };
}

/** Outcome counts if `threshold` were used. */
function outcomesAt(rows, threshold) {
    let localCorrect = 0;
    let localWrong = 0;
    let escalated = 0;
    for (const row of rows) {
        if (row.agreement >= threshold) {
            if (row.correct) localCorrect += 1;
            else localWrong += 1;
        } else {
            escalated += 1;
        }
    }
    return { localCorrect, localWrong, escalated };
}

/**
 * Sweep for the threshold that keeps the fewest wrong answers local, breaking
 * ties toward answering more locally. Encodes the cost asymmetry directly:
 * an unnecessary escalation spends tokens, a wrong local answer misinforms.
 */
export function bestThreshold(rows) {
    const steps = [];
    for (let i = 0; i <= 100; i += 1) {
        const t = i / 100;
        steps.push({ t, outcomes: outcomesAt(rows, t) });
    }

    // Best achievable outcome: fewest wrong local answers, then most correct.
    let target = null;
    for (const step of steps) {
        if (target === null
            || step.outcomes.localWrong < target.localWrong
            || (step.outcomes.localWrong === target.localWrong
                && step.outcomes.localCorrect > target.localCorrect)) {
            target = step.outcomes;
        }
    }

    // Usually a whole band of thresholds achieves that outcome. Taking the
    // lowest would sit flush against the nearest wrong answer, and agreement
    // varies enough between runs that a hairline margin does not survive —
    // one prompt measured 0.587 during calibration and 0.554 in normal use.
    // Take the midpoint of the widest qualifying band instead, which maximises
    // the margin on both sides.
    let bandStart = null;
    let best = null;
    let widest = -1;
    for (let i = 0; i <= steps.length; i += 1) {
        const ok = i < steps.length
            && steps[i].outcomes.localWrong === target.localWrong
            && steps[i].outcomes.localCorrect === target.localCorrect;
        if (ok && bandStart === null) {
            bandStart = i;
        } else if (!ok && bandStart !== null) {
            const width = i - bandStart;
            if (width > widest) {
                widest = width;
                best = steps[Math.floor((bandStart + i - 1) / 2)];
            }
            bandStart = null;
        }
    }

    return {
        threshold: best.t,
        outcomes: best.outcomes,
        // How much room there is on either side before the outcome degrades.
        marginSteps: widest,
    };
}

function mean(xs) {
    return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export async function compareModels(aliases, config, appName) {
    const results = [];

    for (const alias of aliases) {
        process.stderr.write(`\n── ${alias} ─────────────────────────────\n`);
        let loaded;
        try {
            loaded = await loadLocalModel({
                appName,
                alias,
                onDownloadProgress: (p) => process.stderr.write(`\r  downloading ${p.toFixed(0)}%   `),
            });
        } catch (err) {
            process.stderr.write(`  skipped — ${err.message.split('\n')[0]}\n`);
            continue;
        }

        try {
            const stochastic = await probeStochasticity(loaded.model, config);
            if (!stochastic.usable) {
                process.stderr.write('  ⚠ decodes greedily — ignores temperature, so self-consistency cannot measure it\n');
            }
            const { rows, meanLatencyMs, meanTokens } = await measureModel(loaded.model, config);
            const easy = rows.filter((r) => r.tier === 'easy');
            const hard = rows.filter((r) => r.tier === 'hard');
            const best = bestThreshold(rows);

            results.push({
                alias,
                modelId: loaded.model.id,
                stochastic: stochastic.usable,
                distinctSamples: stochastic.distinct,
                easyAgreement: mean(easy.map((r) => r.agreement)),
                hardAgreement: mean(hard.map((r) => r.agreement)),
                gap: Math.min(...easy.map((r) => r.agreement)) - Math.max(...hard.map((r) => r.agreement)),
                // Accuracy on easy prompts regardless of routing — the ceiling
                // on how much this model could ever answer locally and be right.
                easyAccuracy: easy.filter((r) => r.correct).length / easy.length,
                threshold: best.threshold,
                ...best.outcomes,
                total: rows.length,
                meanLatencyMs,
                meanTokens,
            });
            process.stderr.write(`  done — threshold ${best.threshold.toFixed(2)}, ${best.outcomes.localCorrect}/${rows.length} local-correct, ${best.outcomes.localWrong} local-wrong\n`);
        } finally {
            await loaded.model.unload();
        }
    }

    return results;
}

export function formatComparison(results) {
    const lines = [];
    lines.push('');
    lines.push('Local model comparison');
    lines.push('═'.repeat(96));
    lines.push('  model              easy   hard    gap  thresh   local-ok  local-BAD  escalated   latency  tokens');
    lines.push('─'.repeat(96));

    // Models the metric cannot measure are ranked last regardless of score:
    // their numbers describe the runtime's decoding, not the model.
    const ranked = [...results].sort((a, b) =>
        Number(b.stochastic) - Number(a.stochastic)
        || a.localWrong - b.localWrong
        || b.localCorrect - a.localCorrect
        || a.meanLatencyMs - b.meanLatencyMs);

    for (const r of ranked) {
        lines.push(
            `  ${(r.stochastic ? r.alias : `${r.alias} ⚠`).padEnd(18)}`
            + `${r.easyAgreement.toFixed(2).padStart(5)}  `
            + `${r.hardAgreement.toFixed(2).padStart(5)}  `
            + `${r.gap >= 0 ? '+' : ''}${r.gap.toFixed(2).padStart(5)}  `
            + `${r.threshold.toFixed(2).padStart(5)}  `
            + `${String(r.localCorrect).padStart(7)}/${r.total}  `
            + `${String(r.localWrong).padStart(8)}  `
            + `${String(r.escalated).padStart(9)}  `
            + `${(`${(r.meanLatencyMs / 1000).toFixed(1)}s`).padStart(8)}  `
            + `${String(Math.round(r.meanTokens)).padStart(6)}`,
        );
    }

    lines.push('─'.repeat(96));
    lines.push('  easy/hard = mean agreement per class   gap = min(easy) − max(hard), >0 means clean separation');
    lines.push('  local-ok  = kept local and correct     local-BAD = kept local and WRONG (the failure that matters)');
    lines.push('  latency/tokens are per request, across all samples drawn');

    const greedy = ranked.filter((r) => !r.stochastic);
    if (greedy.length > 0) {
        lines.push('');
        lines.push(`  ⚠ ${greedy.map((r) => r.alias).join(', ')} decode greedily and ignore temperature.`);
        lines.push('    Every sample is byte-identical, so agreement is a constant 1.0 and nothing ever');
        lines.push('    escalates. Their rows measure the runtime\'s decoding, not the model — and any');
        lines.push('    router built on self-consistency cannot use them at all.');
    }

    const winner = ranked[0];
    if (winner) {
        lines.push('');
        lines.push(`  Recommended: ${winner.alias} at threshold ${winner.threshold.toFixed(2)}`);
        lines.push(`    answers ${winner.localCorrect}/${winner.total} locally and correctly, with ${winner.localWrong} wrong answers kept local,`);
        lines.push(`    escalating ${winner.escalated}, at ${(winner.meanLatencyMs / 1000).toFixed(1)}s per request.`);
    }
    return lines.join('\n');
}
