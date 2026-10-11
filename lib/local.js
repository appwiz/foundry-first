/*
 * foundry-first — local model sampling via the Foundry Local SDK.
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

import { FoundryLocalManager } from 'foundry-local-sdk';

// Fixed seeds rather than random ones: the confidence score is then
// reproducible for a given prompt, which is what makes a calibrated threshold
// meaningful across runs. Extended by derivation if sampleCount exceeds these.
const BASE_SEEDS = [11, 22, 33, 44, 55];

function seedFor(index) {
    return index < BASE_SEEDS.length ? BASE_SEEDS[index] : 101 + index * 7;
}

/**
 * Remove reasoning blocks from a response.
 *
 * Reasoning models (the qwen3 family, phi-4-reasoning, deepseek-r1) emit their
 * chain of thought inline as `<think>…</think>` before the answer. That text
 * must not reach the confidence metric: it is long, free-form, and varies far
 * more between samples than the answer does, so it would swamp the agreement
 * signal in exactly the way unconstrained prose already did — and would
 * penalise reasoning models for reasoning. It must not reach the user either.
 *
 * Some chat templates (qwen3.5) prefill `<think>\n` into the prompt itself, so
 * the output carries only the closing tag: everything before an orphaned
 * `</think>` is reasoning too. Missing this leaves the whole chain of thought
 * in the answer.
 *
 * An unclosed tag means the sample was cut off mid-thought; everything from the
 * opening tag on is dropped, which leaves an empty string and disqualifies the
 * sample, as it should.
 */
export function stripThinking(text) {
    return text
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/^[\s\S]*?<\/think>/i, '')
        .replace(/<think>[\s\S]*$/i, '')
        .trim();
}

/**
 * Boot the native runtime, resolve the model, download it if this is the first
 * run, and load it into memory. `create()` is synchronous by design — it
 * returns the manager directly and blocks during init.
 */
export async function loadLocalModel({ appName, alias, onDownloadProgress }) {
    const manager = FoundryLocalManager.create({ appName });
    const model = await manager.catalog.getModel(alias);

    if (!model.isCached && onDownloadProgress) {
        await model.download(onDownloadProgress);
    } else if (!model.isCached) {
        await model.download();
    }

    await model.load();
    return { manager, model };
}

/**
 * Draw `sampleCount` independent samples for one prompt.
 *
 * Temperature must be non-zero: at temperature 0 the model is deterministic and
 * every sample would be identical, so agreement would be a constant 1.0 and the
 * confidence signal would carry no information at all.
 */
export async function sampleLocal(model, prompt, { sampleCount, temperature, localMaxTokens, localSystemPrompt }) {
    const client = model.createChatClient();
    client.settings.temperature = temperature;
    client.settings.maxTokens = localMaxTokens;
    const systemPrompt = localSystemPrompt;

    const messages = [];
    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const samples = [];
    const startedAt = Date.now();

    for (let i = 0; i < sampleCount; i += 1) {
        client.settings.randomSeed = seedFor(i);
        let response;
        try {
            response = await client.completeChat(messages);
        } catch (err) {
            // The native core cancels any completion at 120s, and a model the
            // runtime cannot execute fails here too. Either is a fact about the
            // generation, like truncation, so it is recorded as a failed sample
            // for the scorer to disqualify — not thrown, which would cost the
            // user an answer the frontier tier could still give. Stop drawing:
            // the next sample would most likely fail the same way, at up to
            // another 120s each.
            samples.push({
                text: '',
                finishReason: 'error',
                error: err.message.split('\n')[0],
                promptTokens: 0,
                completionTokens: 0,
            });
            break;
        }
        const choice = response.choices?.[0];
        samples.push({
            text: stripThinking(choice?.message?.content ?? ''),
            finishReason: choice?.finish_reason ?? 'unknown',
            promptTokens: response.usage?.prompt_tokens ?? 0,
            completionTokens: response.usage?.completion_tokens ?? 0,
        });
    }

    const localTokens = samples.reduce(
        (sum, s) => sum + s.promptTokens + s.completionTokens,
        0,
    );

    return { samples, latencyMs: Date.now() - startedAt, localTokens };
}

/** Samples the runtime actually produced — failed generations carry no text. */
export function completedSamples(samples) {
    return samples.filter((s) => s.finishReason !== 'error');
}

/**
 * Pick which sample to present as the local answer. The medoid — the sample
 * with the highest total agreement with the others — is the most
 * representative draw from the distribution, and a better choice than simply
 * taking the first. Pass completed samples only; see `completedSamples`.
 */
export function selectRepresentative(samples) {
    if (samples.length === 1) {
        return samples[0];
    }
    // Reuse the same normalization the scorer uses, via a cheap local copy:
    // longer shared-word count with the other samples wins.
    const words = samples.map((s) =>
        new Set(s.text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)),
    );
    let best = 0;
    let bestScore = -1;
    for (let i = 0; i < samples.length; i += 1) {
        let score = 0;
        for (let j = 0; j < samples.length; j += 1) {
            if (i === j) continue;
            for (const w of words[i]) {
                if (words[j].has(w)) score += 1;
            }
        }
        if (score > bestScore) {
            bestScore = score;
            best = i;
        }
    }
    return samples[best];
}
