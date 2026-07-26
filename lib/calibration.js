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
// rather than by guess:
//
//   easy — well within a 0.5B model's competence. Common facts and arithmetic
//          it answers the same way every time. These SHOULD stay local.
//   hard — beyond it: obscure specifics, multi-step reasoning, and questions
//          whose answers it will invent differently on each sample. These
//          SHOULD escalate.
//
// The threshold that separates the two classes is the calibrated threshold.
// Re-run `node index.js --calibrate` after changing the model or sample count,
// since the separation point is a property of the model, not of the metric.

export const CALIBRATION_SET = [
    { tier: 'easy', prompt: 'What is the capital of France? Answer in one word.' },
    { tier: 'easy', prompt: 'What is 7 multiplied by 8?' },
    { tier: 'easy', prompt: 'How many days are in a week?' },
    { tier: 'easy', prompt: 'What color is the sky on a clear day? One word.' },
    { tier: 'easy', prompt: 'What is the chemical symbol for water?' },
    { tier: 'easy', prompt: 'Name the largest ocean on Earth.' },

    { tier: 'hard', prompt: 'What was the exact GDP per capita of Botswana in 1987 in US dollars?' },
    { tier: 'hard', prompt: 'A train leaves at 14:23 travelling 87 km/h and another leaves 41 minutes later at 112 km/h from 260 km away. At what clock time do they meet?' },
    { tier: 'hard', prompt: 'Which specific amendment to the Icelandic fisheries management act of 1990 introduced the transferable quota provision, and in what year?' },
    { tier: 'hard', prompt: 'Prove that the sum of the first n odd integers equals n squared, then extend the argument to the sum of the first n cubes.' },
    { tier: 'hard', prompt: 'What are the third and fourth movements of Alkan\'s Symphony for Solo Piano, and in which keys?' },
    { tier: 'hard', prompt: 'Summarize the disagreement between the majority and the dissent in the 1962 Belgian Linguistics case before the European Court of Human Rights.' },
];
