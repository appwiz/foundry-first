/*
 * foundry-first — routing metrics, persisted across runs.
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

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const EMPTY = {
    totalRequests: 0,
    localSufficient: 0,
    escalated: 0,
    localTokens: 0,
    remoteInputTokens: 0,
    remoteOutputTokens: 0,
    localLatencyMsTotal: 0,
    remoteLatencyMsTotal: 0,
    refusals: 0,
    escalationFailures: 0,
};

export function metricsPath(appName) {
    return join(homedir(), `.${appName}`, 'router-metrics.json');
}

/** A zeroed metrics record — used to reset accumulated history. */
export function empty() {
    return { ...EMPTY };
}

export function load(appName) {
    try {
        const raw = readFileSync(metricsPath(appName), 'utf8');
        return { ...EMPTY, ...JSON.parse(raw) };
    } catch {
        // Absent or unreadable file means no history yet — start clean.
        return { ...EMPTY };
    }
}

export function save(appName, metrics) {
    const path = metricsPath(appName);
    mkdirSync(join(homedir(), `.${appName}`), { recursive: true });
    writeFileSync(path, `${JSON.stringify(metrics, null, 2)}\n`);
}

export function record(metrics, entry) {
    const next = { ...metrics };
    next.totalRequests += 1;
    next.localTokens += entry.localTokens;
    next.localLatencyMsTotal += entry.localLatencyMs;

    if (entry.escalationFailed) {
        // The local tier was judged insufficient but the frontier tier never
        // answered. Counting this as local sufficiency would inflate the
        // headline number with requests the router itself deemed unanswerable
        // locally, so it is tracked separately and excluded from the rate.
        next.escalationFailures += 1;
    } else if (entry.escalated) {
        next.escalated += 1;
        next.remoteInputTokens += entry.remoteInputTokens ?? 0;
        next.remoteOutputTokens += entry.remoteOutputTokens ?? 0;
        next.remoteLatencyMsTotal += entry.remoteLatencyMs ?? 0;
        if (entry.refused) {
            next.refusals += 1;
        }
    } else {
        next.localSufficient += 1;
    }
    return next;
}

/**
 * Derive the reported figures.
 *
 * Savings are counterfactual — we never actually made the calls we avoided — so
 * they are computed from the *measured* mean cost of the escalations that did
 * happen, and labelled as estimates. With no escalations yet there is no
 * measured baseline, and the estimates are reported as unavailable rather than
 * guessed at.
 */
export function summarize(metrics) {
    const {
        totalRequests, localSufficient, escalated,
        localTokens, remoteInputTokens, remoteOutputTokens,
        localLatencyMsTotal, remoteLatencyMsTotal, refusals, escalationFailures,
    } = metrics;

    const remoteTokens = remoteInputTokens + remoteOutputTokens;
    const hasBaseline = escalated > 0;
    // Requests the router actually resolved. Failed escalations are excluded:
    // neither tier answered them, so they belong in no rate.
    const decided = localSufficient + escalated;

    const meanRemoteTokens = hasBaseline ? remoteTokens / escalated : null;
    const meanRemoteLatencyMs = hasBaseline ? remoteLatencyMsTotal / escalated : null;

    return {
        totalRequests,
        localSufficient,
        escalated,
        refusals,
        escalationFailures,
        localSufficiencyRate: decided > 0 ? localSufficient / decided : 0,
        localTokens,
        remoteTokens,
        remoteInputTokens,
        remoteOutputTokens,
        meanLocalLatencyMs: totalRequests > 0 ? localLatencyMsTotal / totalRequests : 0,
        meanRemoteLatencyMs,
        // Counterfactual: what those avoided calls would have cost, priced at
        // the measured mean of the calls we did make.
        estimatedTokensAvoided: hasBaseline ? Math.round(meanRemoteTokens * localSufficient) : null,
        estimatedLatencySavedMs: hasBaseline ? Math.round(meanRemoteLatencyMs * localSufficient) : null,
        hasBaseline,
    };
}

function pct(n) {
    return `${(n * 100).toFixed(1)}%`;
}

function ms(n) {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}

export function format(summary) {
    const lines = [];
    lines.push('Routing metrics (cumulative)');
    lines.push('─'.repeat(46));
    lines.push(`  Requests                ${summary.totalRequests}`);
    lines.push(`  Answered locally        ${summary.localSufficient}  (${pct(summary.localSufficiencyRate)})`);
    lines.push(`  Escalated               ${summary.escalated}`);
    if (summary.refusals > 0) {
        lines.push(`  Frontier refusals       ${summary.refusals}`);
    }
    if (summary.escalationFailures > 0) {
        lines.push(`  Escalations failed      ${summary.escalationFailures}  (excluded from rate)`);
    }
    lines.push('');
    lines.push(`  Local tokens            ${summary.localTokens.toLocaleString()}  (free, on-device)`);
    lines.push(`  Frontier tokens spent   ${summary.remoteTokens.toLocaleString()}  (${summary.remoteInputTokens.toLocaleString()} in / ${summary.remoteOutputTokens.toLocaleString()} out)`);

    if (summary.hasBaseline) {
        lines.push(`  Frontier tokens avoided ~${summary.estimatedTokensAvoided.toLocaleString()}  (est. from measured mean)`);
    } else {
        lines.push('  Frontier tokens avoided  n/a — no escalation yet to measure a baseline against');
    }

    lines.push('');
    lines.push(`  Mean local latency      ${ms(summary.meanLocalLatencyMs)}`);
    if (summary.hasBaseline) {
        lines.push(`  Mean frontier latency   ${ms(summary.meanRemoteLatencyMs)}`);
        lines.push(`  Latency avoided         ~${ms(summary.estimatedLatencySavedMs)}  (est. from measured mean)`);
    } else {
        lines.push('  Mean frontier latency    n/a — no escalation yet');
    }
    return lines.join('\n');
}
