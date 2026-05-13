/**
 * Tiny CLI demo for the L1 heatmap engine. Run with:
 *   npm run demo -- m
 *   npm run demo -- t
 *   npm run demo -- i
 *
 * Prints, for the clicked phoneme, a coloured ASCII bar chart of
 * P(other ∈ inventory | clicked ∈ inventory) over the built-in IPA chart,
 * plus the Wikimedia Commons audio URL.
 */

import { buildCoOccurrenceModel } from './cooccurrence.js';
import { audioUrlFor } from './audio.js';
import { PULMONIC_CONSONANTS, CARDINAL_VOWELS } from './ipa-chart.js';

const active = process.argv[2];
if (!active) {
  console.error('usage: npm run demo -- <ipa-symbol>   (try: p t k m n i a u s ʃ)');
  process.exit(1);
}

const model = buildCoOccurrenceModel();
const allIpa = [
  ...PULMONIC_CONSONANTS.map(c => c.ipa),
  ...CARDINAL_VOWELS.map(v => v.ipa),
];

if (model.marginal(active) === 0) {
  console.error(`/${active}/ is not attested in the bundled corpus`);
  process.exit(1);
}

const weights = model.heatmapWeights(active, allIpa);

function bar(w: number, width = 30): string {
  const n = Math.round(w * width);
  const hot = w > 0.66, warm = w > 0.33;
  const color = hot ? '\x1b[31m' : warm ? '\x1b[33m' : '\x1b[36m';
  return `${color}${'█'.repeat(n)}${'·'.repeat(width - n)}\x1b[0m`;
}

console.log(`\nclicked /${active}/   corpus = ${model.corpusSize} inventories`);
console.log(`audio:  ${audioUrlFor(active) ?? '(none)'}\n`);
console.log('phoneme  P(·|active)  heatmap');
console.log('-------  -----------  ------------------------------');

const sorted = [...weights.entries()].sort((a, b) => b[1] - a[1]);
for (const [ipa, w] of sorted) {
  const pad = ipa.padEnd(6);
  console.log(`  ${pad}   ${w.toFixed(3)}      ${bar(w)}`);
}
