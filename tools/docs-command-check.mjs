#!/usr/bin/env node
// Every CLI subcommand and repo path our docs name must actually exist.
//
// This gate exists because of a specific bug, not a hypothetical one. The
// README documented the MCP server entry as `hayba-toolkit` while the tooling
// wrote and looked for `hayba` — so anyone who installed by following the
// README was told by `doctor` that their working install was unconfigured.
//
// Nothing caught it. The test suite was green, the tool ran correctly, and the
// docs were internally consistent. The two halves were each fine and disagreed
// with each other, which is a class of defect that only shows up when someone
// reads both at once. That is what this automates.
//
//   node tools/docs-command-check.mjs
//   node tools/docs-command-check.mjs --check   (same; exits 1 on a mismatch)

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_SRC = join(ROOT, 'mcp-tools', 'hayba-mcp', 'src', 'cli', 'index.ts');

/** Docs that describe the product. Design notes are a working record — they
 *  are allowed to describe things that were considered and never built. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'docs/design', 'website']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = relative(ROOT, abs).split('\\').join('/');
    if (SKIP_DIRS.has(name) || SKIP_DIRS.has(rel)) continue;
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (abs.endsWith('.md')) out.push(abs);
  }
  return out;
}

// ---------------------------------------------------------------- subcommands
// Read the routing, not a hand-kept list: `if (specPath === 'doctor')`.
const cliSrc = readFileSync(CLI_SRC, 'utf8');
const known = new Set(
  [...cliSrc.matchAll(/specPath === '([a-z-]+)'/g)].map((m) => m[1]),
);
// `--help`/`-h` are handled separately in the same function.
known.add('--help');
known.add('-h');

if (known.size <= 2) {
  console.error('docs-command-check: found no subcommands in cli/index.ts — the routing shape changed, fix this script');
  process.exit(1);
}

const INVOKE = /(?:hayba-cli|cli[\\/]index\.js)\s+([a-z][a-z-]*)/g;

const problems = [];
const seen = new Map();

for (const file of walk(ROOT)) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file).split('\\').join('/');

  for (const m of src.matchAll(INVOKE)) {
    const sub = m[1];
    seen.set(sub, [...(seen.get(sub) ?? []), rel]);
    if (!known.has(sub)) {
      problems.push(`${rel}: documents "${sub}", which the CLI does not route`);
    }
  }
}

// ------------------------------------------------------- the naming trap
// The bug that motivated this file. Docs may show an example entry name, but
// must not imply the name is what identifies the server.
//
// Checked LINE BY LINE, with the disclaimer required NEAR the prescription.
// The first version of this check scanned whole files, so a disclaimer in one
// section excused a prescription in another -- and a deliberate re-break of
// the original bug sailed straight through it. A gate with file granularity
// is a gate that passes for the wrong reason.
const DISCLAIMER = /name is yours to choose|whatever the entry is called|not by what|name is arbitrary/i;
const PRESCRIBES = /mcp add\s+hayba-toolkit|"hayba-toolkit"\s*:/;
const NEAR = 8; // lines either side

for (const file of walk(ROOT)) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file).split('\\').join('/');
  const lines = src.split('\n');

  lines.forEach((line, i) => {
    if (!PRESCRIBES.test(line)) return;
    const window = lines.slice(Math.max(0, i - NEAR), i + NEAR + 1).join('\n');
    if (DISCLAIMER.test(window)) return;
    problems.push(
      `${rel}:${i + 1}: prescribes the MCP entry name "hayba-toolkit" with no ` +
        `note nearby that the name is arbitrary — this is the mismatch that ` +
        `made doctor call working installs broken`,
    );
  });
}


// ------------------------------------------------- numeric claims in RELIABILITY
// RELIABILITY.md is a public page asserting specific counts, and its handler
// count had already drifted once. Prose cannot be checked mechanically, but a
// number can, and a number is what goes stale: nobody rereads a reliability
// page when they add a handler.
{
  const relPath = join(ROOT, 'docs', 'RELIABILITY.md');
  if (existsSync(relPath)) {
    const rel = readFileSync(relPath, 'utf8');
    const modulePath = join(
      ROOT, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit',
      'Private', 'HaybaMCPModule.cpp',
    );
    if (existsSync(modulePath)) {
      const mod = readFileSync(modulePath, 'utf8');
      const actual = (mod.match(/CommandHandler->RegisterHandler\(MakeShared</g) ?? []).length;
      const claimed = rel.match(/the (\d+) registered by the core\s+module/);
      if (!claimed) {
        problems.push(
          'docs/RELIABILITY.md: the core-module handler-count sentence changed shape — ' +
            'update this check along with it, or the number stops being verified',
        );
      } else if (Number(claimed[1]) !== actual) {
        problems.push(
          `docs/RELIABILITY.md: claims ${claimed[1]} handlers registered by the core ` +
            `module; HaybaMCPModule.cpp registers ${actual}`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error('docs and CLI disagree:\n');
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nFix the doc, or the routing it describes.');
  process.exit(1);
}

const subs = [...seen.keys()].sort();
console.error(
  `ok: ${subs.length} CLI subcommand(s) referenced in docs all route (${subs.join(', ')})`,
);
