/*
 * foundry-first — labelled prompt set for threshold calibration.
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

// Two labelled classes, used to place the escalation threshold empirically
// rather than by guess, and to compare candidate local models:
//
//   easy — well within a small model's competence. Each carries `expect`, a
//          list of strings of which at least one must appear in the answer for
//          it to count as correct. These SHOULD stay local, and be right.
//   hard — beyond a small model: obscure specifics and multi-step reasoning it
//          will answer differently on each sample. These SHOULD escalate.
//          The computable ones carry `expect` too, so a model that genuinely
//          solves one is credited rather than punished for answering locally.
//          The rest are unknowable trivia with no `expect`, where keeping the
//          answer local is an error by assumption — an assumption worth
//          spot-checking rather than trusting when a larger model is tested.
//
// `expect` is what separates *confidence* from *correctness*. Agreement alone
// cannot tell a model that knows the answer from one that is reliably wrong in
// the same way, so model selection needs both measurements.

export const CALIBRATION_SET = [
    {
        tier: 'easy',
        prompt: 'What is the capital of France? Answer in one word.',
        expect: ['paris'],
    },
    {
        tier: 'easy',
        prompt: 'What is 7 multiplied by 8?',
        expect: ['56'],
    },
    {
        tier: 'easy',
        prompt: 'How many days are in a week?',
        expect: ['7', 'seven'],
    },
    {
        tier: 'easy',
        prompt: 'What color is the sky on a clear day? One word.',
        expect: ['blue'],
    },
    {
        tier: 'easy',
        prompt: 'What is the chemical symbol for water?',
        expect: ['h2o', 'h₂o'],
    },
    {
        tier: 'easy',
        prompt: 'Name the largest ocean on Earth.',
        expect: ['pacific'],
    },
    {
        tier: 'easy',
        prompt: 'In which year did the Second World War end?',
        expect: ['1945'],
    },
    {
        tier: 'easy',
        prompt: 'What is the square root of 144?',
        expect: ['12', 'twelve'],
    },
    {
        tier: 'easy',
        prompt: 'Who wrote the play Romeo and Juliet?',
        expect: ['shakespeare'],
    },
    {
        tier: 'easy',
        prompt: 'What is the freezing point of water in degrees Celsius?',
        expect: ['0', 'zero'],
    },

    {
        tier: 'hard',
        prompt: 'What was the exact GDP per capita of Botswana in 1987 in US dollars?',
    },
    {
        tier: 'hard',
        prompt: 'A train leaves at 14:23 travelling 87 km/h and another leaves 41 minutes later at 112 km/h from 260 km away. At what clock time do they meet?',
        // Solvable, so it is graded rather than assumed wrong: a model that
        // gets it right earns credit for answering locally. Verified by hand.
        expect: ['16:04', '4:04'],
    },
    {
        tier: 'hard',
        prompt: 'Which specific amendment to the Icelandic fisheries management act of 1990 introduced the transferable quota provision, and in what year?',
    },
    {
        tier: 'hard',
        prompt: 'Prove that the sum of the first n odd integers equals n squared, then extend the argument to the sum of the first n cubes.',
    },
    {
        tier: 'hard',
        prompt: 'What are the third and fourth movements of Alkan\'s Symphony for Solo Piano, and in which keys?',
    },
    {
        tier: 'hard',
        prompt: 'Summarize the disagreement between the majority and the dissent in the 1962 Belgian Linguistics case before the European Court of Human Rights.',
    },
    {
        tier: 'hard',
        prompt: 'What was the registered tonnage of the Swedish cargo vessel Nyland when it was launched, and at which yard?',
    },
    {
        tier: 'hard',
        prompt: 'A cylindrical tank of radius 1.7 m is filled at 240 L/min while draining at 3.1 L/s. Starting empty, what is the water depth after 22 minutes?',
        // Net 54 L/min × 22 min = 1.188 m³ over π(1.7)² = 9.079 m² → 0.1308 m.
        expect: ['0.13', '13.1', '13 cm'],
    },
    {
        tier: 'hard',
        prompt: 'Which clauses of the 1878 Treaty of Berlin specifically addressed Montenegrin port access, and how were they later modified?',
    },
    {
        tier: 'hard',
        prompt: 'Derive the stationary distribution of a three-state Markov chain with transition matrix rows [0.2,0.5,0.3], [0.6,0.1,0.3], [0.4,0.4,0.2].',
        // π ≈ (0.3896, 0.3377, 0.2727), by power iteration.
        expect: ['0.39', '0.3896'],
    },
];

/** Does an answer contain any of the accepted forms? */
export function isCorrect(item, text) {
    if (!item.expect) {
        // Hard prompts carry no ground truth: the labelling assumption is that
        // a small local model cannot answer them, so keeping one local is
        // treated as an error regardless of what it said.
        return false;
    }
    const normalized = text.toLowerCase();
    return item.expect.some((form) => normalized.includes(form));
}
