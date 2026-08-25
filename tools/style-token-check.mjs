#!/usr/bin/env node
// Every style token a panel asks for must exist in the style set.
//
// FHaybaMCPStyle::Colour returns MAGENTA for an unknown token — deliberately,
// because on cool dark chrome a missing token returning black or white looks
// like a design choice and ships unnoticed. Magenta is loud, but only to
// someone who opens that panel, on that tab, in that state.
//
// A typo'd token name compiles, links, runs, and is wrong. This is the check
// that turns "you would notice eventually" into "the build says so".
//
//   node tools/style-token-check.mjs
//   node tools/style-token-check.mjs --check   (same; exits 1 on a miss)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE = join(ROOT, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private');
const STYLE = join(PRIVATE, 'HaybaMCPStyle.cpp');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.cpp')) out.push(p);
  }
  return out;
}

const style = readFileSync(STYLE, 'utf8');
const registered = new Set([...style.matchAll(/Tok\(TEXT\("([^"]+)"\)/g)].map((m) => m[1]));

/** token -> files that ask for it */
const used = new Map();
for (const file of walk(PRIVATE)) {
  if (basename(file) === 'HaybaMCPStyle.cpp') continue;
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/Colour\("([^"]+)"\)/g)) {
    const list = used.get(m[1]) ?? [];
    list.push(basename(file));
    used.set(m[1], list);
  }
  for (const m of src.matchAll(/Metric\("([^"]+)"\)/g)) {
    const list = used.get(m[1]) ?? [];
    list.push(basename(file));
    used.set(m[1], list);
  }
}

const missing = [...used.entries()].filter(([t]) => !registered.has(t));

if (missing.length > 0) {
  console.error('style tokens referenced but not registered — these render MAGENTA:\n');
  for (const [token, files] of missing) {
    console.error(`  ${token}`);
    for (const f of [...new Set(files)].sort()) console.error(`      ${f}`);
  }
  console.error('\nAdd them in HaybaMCPStyle.cpp, or fix the name at the call site.');
  process.exit(1);
}

console.error(
  `ok: all ${used.size} referenced style token(s) are registered (${registered.size} defined)`,
);
