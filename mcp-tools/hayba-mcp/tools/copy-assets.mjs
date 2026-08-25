#!/usr/bin/env node
// Copy the non-TypeScript files tsc does not: data the server reads at runtime.
//
// This used to be a one-line `node -e` in package.json. It referenced
// src/slivers/specs and *.sliver.json, and when those were renamed the build
// broke while every test stayed green -- vitest runs from src/, so nothing
// exercised the packaged layout. A script can be read, can explain itself, and
// can fail with the name of the thing that is missing.
//
//   node tools/copy-assets.mjs           copy
//   node tools/copy-assets.mjs --check   verify sources exist; copy nothing

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

/** @type {Array<{from: string, to: string, match?: RegExp, why: string}>} */
const ASSETS = [
  { from: 'src/tools/routing/packs.yaml', to: 'dist/tools/routing/packs.yaml',
    why: 'tool routing packs' },
  { from: 'src/recipes/specs', to: 'dist/recipes/specs', match: /\.recipe\.json$/,
    why: 'bundled Recipe specs, seeded into the user library on first run' },
  { from: 'src/plumb/starter-grammar.json', to: 'dist/plumb/starter-grammar.json',
    why: 'starter room grammar, seeded on first run' },
  { from: 'src/legacy-commands/sidecar.json', to: 'dist/legacy-commands/sidecar.json',
    why: 'legacy command descriptors' },
  { from: 'src/legacy-commands/sidecar.schema.json', to: 'dist/legacy-commands/sidecar.schema.json',
    why: 'schema for the above' },
];

const missing = [];
let copied = 0;

for (const a of ASSETS) {
  const from = join(ROOT, a.from);
  if (!existsSync(from)) {
    missing.push(`${a.from} (${a.why})`);
    continue;
  }
  if (check) continue;

  if (a.match) {
    mkdirSync(join(ROOT, a.to), { recursive: true });
    const names = readdirSync(from).filter((f) => a.match.test(f));
    if (names.length === 0) missing.push(`${a.from} matched no ${a.match} files (${a.why})`);
    for (const f of names) {
      copyFileSync(join(from, f), join(ROOT, a.to, f));
      copied += 1;
    }
  } else {
    mkdirSync(dirname(join(ROOT, a.to)), { recursive: true });
    copyFileSync(from, join(ROOT, a.to));
    copied += 1;
  }
}

if (missing.length > 0) {
  console.error('build assets missing — the packaged server would be incomplete:\n');
  for (const m of missing) console.error(`  ${m}`);
  console.error('\nA rename that moves one of these must move it here too.');
  process.exit(1);
}

console.error(check ? `ok: all ${ASSETS.length} build asset source(s) present` : `[copy-assets] copied ${copied} file(s)`);
