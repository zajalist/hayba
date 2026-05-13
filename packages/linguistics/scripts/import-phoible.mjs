#!/usr/bin/env node
/**
 * Import a PHOIBLE CSV export into the linguistics package as
 * `src/data/inventories.phoible.json`. Invoke via:
 *
 *     npm run import:phoible --workspace @hayba/linguistics -- /path/to/phoible.csv
 *
 * The output JSON is gitignored by default — every contributor downloads their
 * own PHOIBLE snapshot. PHOIBLE is CC-BY-SA 4.0; attribute appropriately when
 * redistributing builds that include the full corpus.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadInventoriesFromPhoible } from '../dist/data/inventories.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: import-phoible.mjs <path-to-phoible.csv>');
    process.exit(1);
  }
  const csvPath = resolve(arg);
  console.error(`hayba: loading PHOIBLE corpus from ${csvPath} ...`);
  const inventories = await loadInventoriesFromPhoible(csvPath);
  const out = join(__dirname, '..', 'src', 'data', 'inventories.phoible.json');
  await writeFile(out, JSON.stringify(inventories), 'utf8');
  console.error(`hayba: wrote ${inventories.length} inventories to ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
