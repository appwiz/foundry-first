/*
 * foundry-first — objective confidence scoring for local model output.
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

// The confidence signal is SELF-CONSISTENCY, not self-report.
//
// The ideal objective measure would be token-level logprobs (mean logprob /
// perplexity), but the Foundry Local runtime does not expose them: the FFI chat
// path omits the field entirely, and the HTTP Responses API returns an empty
// `logprobs: []` with no request parameter to populate it. See README.md.
//
// Self-consistency is the standard substitute. Sampling the same prompt K times
// at a fixed temperature with distinct seeds draws K independent samples from
// the model's output distribution; the agreement between those samples is an
// empirical estimator of that distribution's entropy — the same quantity
// logprobs would have measured directly. It is objective in the sense that
// matters here: it is computed from observed outputs, never asked of the model.

// Words carrying no discriminating content. Two answers that agree only on
// these agree on nothing, so they are removed before comparison.
const STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can',
    'do', 'does', 'for', 'from', 'has', 'have', 'here', 'how', 'i', 'if',
    'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their',
    'there', 'these', 'they', 'this', 'to', 'was', 'were', 'what', 'when',
    'which', 'will', 'with', 'would', 'you', 'your',
]);

/**
 * Reduce a response to its set of content words: lowercased, stripped of
 * punctuation, stopwords removed.
 */
function contentTokens(text) {
    const words = text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 0 && !STOPWORDS.has(w));
    return new Set(words);
}

/**
 * Szymkiewicz–Simpson overlap coefficient: |A ∩ B| / min(|A|, |B|).
 *
 * Chosen over cosine or Jaccard because answer *length* varies far more than
 * answer *content* across samples — "Paris" and "The capital of France is
 * Paris" agree completely on substance, and a length-sensitive measure would
 * wrongly score that pair as disagreement. Overlap is insensitive to that
 * padding. The tradeoff is that a short sample fully contained in a longer one
 * always scores 1.0, which is why `scoreSamples` also requires every sample to
 * be non-degenerate before the score is trusted.
 */
function overlapCoefficient(a, b) {
    if (a.size === 0 || b.size === 0) {
        return 0;
    }
    let shared = 0;
    for (const token of a) {
        if (b.has(token)) {
            shared += 1;
        }
    }
    return shared / Math.min(a.size, b.size);
}

/** Numerals appearing in a response, normalized so 1,200 and 1200 match. */
function numericTokens(text) {
    const matches = text.match(/\d[\d,.]*/g) ?? [];
    return new Set(matches.map((n) => n.replace(/[,.]$/, '').replace(/,/g, '')));
}

/**
 * Agreement between one pair of samples.
 *
 * Word overlap alone is too forgiving on quantitative answers: asked for a
 * figure it does not know, the model emits the same confident sentence with a
 * different number each time, and the prose carries the score. Measured at
 * calibration, "GDP per capita of Botswana in 1987" scored 0.778 on words
 * alone while every sample named a different figure.
 *
 * When both samples quote numbers, the pair can therefore score no higher than
 * the agreement between those numbers — a disagreement of fact cannot be
 * papered over by agreement of phrasing.
 */
function pairAgreement(textA, textB, wordsA, wordsB) {
    const wordScore = overlapCoefficient(wordsA, wordsB);
    const numsA = numericTokens(textA);
    const numsB = numericTokens(textB);
    if (numsA.size === 0 || numsB.size === 0) {
        return wordScore;
    }
    return Math.min(wordScore, overlapCoefficient(numsA, numsB));
}

/**
 * Score a set of independently sampled responses to the same prompt.
 *
 * Returns the mean pairwise agreement across all K*(K-1)/2 sample pairs, plus
 * any hard disqualifiers. Hard disqualifiers are objective facts about the
 * generation itself (truncation, empty output) that make the agreement score
 * meaningless, so they force escalation regardless of it.
 */
export function scoreSamples(samples) {
    const reasons = [];

    // A sample cut off at the token limit is incomplete by definition — the
    // model never got to finish, so agreement between fragments proves nothing.
    if (samples.some((s) => s.finishReason === 'length')) {
        reasons.push('a sample hit the output token limit (truncated)');
    }

    const tokenSets = samples.map((s) => contentTokens(s.text));

    // A sample with no content words carries no information to agree about.
    if (tokenSets.some((set) => set.size === 0)) {
        reasons.push('a sample returned no content words');
    }

    let agreement = 0;
    let pairs = 0;
    for (let i = 0; i < tokenSets.length; i += 1) {
        for (let j = i + 1; j < tokenSets.length; j += 1) {
            agreement += pairAgreement(
                samples[i].text, samples[j].text, tokenSets[i], tokenSets[j],
            );
            pairs += 1;
        }
    }
    // A single sample has no pair to compare against; treat as unmeasurable.
    const meanAgreement = pairs > 0 ? agreement / pairs : 0;
    if (pairs === 0) {
        reasons.push('need at least 2 samples to measure agreement');
    }

    return { agreement: meanAgreement, disqualifiers: reasons };
}

/**
 * Apply the escalation policy to a score. Separated from scoring so the
 * threshold can be recalibrated (see `--calibrate`) without touching the metric.
 */
export function shouldEscalate(score, threshold) {
    if (score.disqualifiers.length > 0) {
        return { escalate: true, reason: score.disqualifiers[0] };
    }
    if (score.agreement < threshold) {
        return {
            escalate: true,
            reason: `agreement ${score.agreement.toFixed(3)} below threshold ${threshold.toFixed(3)}`,
        };
    }
    return { escalate: false, reason: null };
}
