/*
 * foundry-first — frontier-model escalation via the Anthropic API.
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

import Anthropic from '@anthropic-ai/sdk';

export const FRONTIER_MODEL = 'claude-opus-5';

const SYSTEM_PROMPT = `You are the escalation tier of a two-tier answering system.

A small local model answered this question first, but its answer was flagged as
low confidence: sampled several times, its answers disagreed with each other.
The disagreeing drafts are provided as context.

Treat the drafts as evidence of what the small model found uncertain, not as
authority. Where a draft is right, you may build on it; where it is wrong or
confused, correct it silently. Do not narrate the drafts, grade them, or mention
that a local model was involved — just answer the user's question directly and
correctly.`;

/**
 * Build the escalation prompt. The local drafts ride along as context so the
 * work already done is reused rather than discarded — this is what makes the
 * result a combined answer rather than a plain remote one.
 */
function buildPrompt(prompt, drafts, escalationReason) {
    const draftBlock = drafts
        .map((d, i) => `<draft index="${i + 1}">\n${d.text.trim()}\n</draft>`)
        .join('\n');

    return `<question>\n${prompt}\n</question>

<local_model_drafts reason_flagged="${escalationReason}">
${draftBlock}
</local_model_drafts>

Answer the question.`;
}

/**
 * Report whether Anthropic credentials are resolvable.
 *
 * An unset ANTHROPIC_API_KEY does not by itself mean there are no credentials —
 * the SDK also resolves ANTHROPIC_AUTH_TOKEN and an `ant auth login` profile
 * stored on disk. The zero-argument constructor handles all of those, so this
 * only reports the env vars we can see and lets construction be the real test.
 */
export function credentialHint() {
    if (process.env.ANTHROPIC_API_KEY) return 'ANTHROPIC_API_KEY';
    if (process.env.ANTHROPIC_AUTH_TOKEN) return 'ANTHROPIC_AUTH_TOKEN';
    return null;
}

/**
 * Escalate to the frontier model, streaming the answer to `onText` as it
 * generates. Returns the full text plus exact token usage and latency.
 */
export async function escalate(prompt, drafts, escalationReason, { onText, maxTokens }) {
    // Zero-arg constructor: resolves ANTHROPIC_API_KEY, then
    // ANTHROPIC_AUTH_TOKEN, then an `ant auth login` profile on disk.
    const client = new Anthropic();
    const startedAt = Date.now();

    const stream = client.beta.messages.stream({
        model: FRONTIER_MODEL,
        max_tokens: maxTokens,
        // Adaptive thinking is on by default for this model; stated explicitly
        // so the intent survives a future model swap.
        thinking: { type: 'adaptive' },
        // Claude Opus 5 safety classifiers can decline a request outright.
        // "default" re-runs a declined request on Anthropic's recommended
        // fallback model, routed by refusal category, instead of returning a
        // refusal to the user.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildPrompt(prompt, drafts, escalationReason) }],
    });

    stream.on('text', (delta) => onText(delta));

    const message = await stream.finalMessage();
    const latencyMs = Date.now() - startedAt;

    // Check stop_reason before trusting content: on a refusal the content array
    // is empty (declined before output) or partial (declined mid-stream).
    if (message.stop_reason === 'refusal') {
        return {
            text: '',
            refused: true,
            refusalCategory: message.stop_details?.category ?? null,
            inputTokens: message.usage?.input_tokens ?? 0,
            outputTokens: message.usage?.output_tokens ?? 0,
            latencyMs,
            servedBy: message.model,
        };
    }

    const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');

    return {
        text,
        refused: false,
        refusalCategory: null,
        inputTokens: message.usage?.input_tokens ?? 0,
        outputTokens: message.usage?.output_tokens ?? 0,
        latencyMs,
        servedBy: message.model,
    };
}
