#!/usr/bin/env node
// Every tool named in a shipped prompt or skill must actually exist.
//
// The agent prompt told models to "always call hayba_generate_moodboard or
// hayba_fetch_references at the start of a new scene task". Neither has ever
// been implemented, so every new-scene task opened with a failed tool call.
// Two workflow skills named a third phantom, hayba_compare_clip_score.
//
// This is the dead-validator-rule problem wearing different clothes: a
// promise nothing keeps. It is worse here, because a catalogue entry is only
// read when someone looks, while a system prompt is read every single time.
//
// Usage:
//   node tools/prompt-tool-check.mjs            # report
//   node tools/prompt-tool-check.mjs --check    # exit 1 if any name is a ghost
//
// Sources of truth for "exists":
//   - commands declared in a C++ GetCommands() body
//   - commands described in sidecar.json
//   - tools registered in TypeScript (defer(...) / ueTool(...) / name: '...')

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MCP = join(ROOT, 'mcp-tools', 'hayba-mcp');
const PLUGIN = join(ROOT, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit');

/** Meta-tools and skill-level verbs that are not MCP commands. */
const NOT_COMMANDS = new Set([
  'list_tool_categories', 'get_tool_signature', 'python_run', 'hayba_invoke',
]);

function walk(dir, pred, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      walk(p, pred, out);
    } else if (pred(p)) out.push(p);
  }
  return out;
}

// ── what exists ─────────────────────────────────────────────────────────────
const known = new Set(NOT_COMMANDS);

// C++: only inside a GetCommands() body, same rule as capability-inventory.
for (const f of walk(join(PLUGIN, 'Private'), (p) => p.endsWith('.cpp'))) {
  const src = readFileSync(f, 'utf8');
  const re = /GetCommands\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = re.exec(src))) {
    for (const s of m[1].matchAll(/TEXT\("([a-z0-9_]+)"\)/g)) known.add(s[1]);
  }
}

const sidecar = join(MCP, 'src', 'legacy-commands', 'sidecar.json');
if (existsSync(sidecar)) {
  const json = JSON.parse(readFileSync(sidecar, 'utf8'));
  const entries = Array.isArray(json) ? json : Object.values(json).flat();
  for (const e of entries) {
    const name = typeof e === 'string' ? e : e?.name ?? e?.command;
    if (name) known.add(name);
  }
  if (!Array.isArray(json)) for (const k of Object.keys(json)) known.add(k);
}

// TypeScript registrations.
for (const f of walk(join(MCP, 'src'), (p) => p.endsWith('.ts') && !p.endsWith('.test.ts'))) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/['"`](hayba_[a-z0-9_]+|[a-z][a-z0-9]*_[a-z0-9_]+)['"`]/g)) {
    known.add(m[1]);
  }
}

// ── what is claimed ─────────────────────────────────────────────────────────
const claims = [];

function claim(file, line, name) {
  claims.push({ file: relative(ROOT, file), line, name });
}

const agents = join(MCP, 'hayba.agents.json');
if (existsSync(agents)) {
  const lines = readFileSync(agents, 'utf8').split('\n');
  lines.forEach((l, i) => {
    for (const m of l.matchAll(/\b(hayba_[a-z0-9_]+|[a-z][a-z0-9]*_[a-z0-9_]+)\b/g)) {
      if (/system_prompt|description/.test(l)) claim(agents, i + 1, m[1]);
    }
  });
}

for (const f of walk(join(MCP, 'addons'), (p) => p.endsWith('SKILL.md'))) {
  readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
    // Only backticked identifiers -- prose should not be guessed at.
    for (const m of l.matchAll(/`([a-z][a-z0-9_]*_[a-z0-9_]+)`/g)) claim(f, i + 1, m[1]);
  });
}

// ── report ──────────────────────────────────────────────────────────────────
const ghosts = claims.filter((c) => !known.has(c.name));
const unique = [...new Set(ghosts.map((g) => g.name))].sort();

if (ghosts.length === 0) {
  console.log(`ok: every tool named in a prompt or skill exists (${claims.length} references checked against ${known.size} known commands)`);
  process.exit(0);
}

console.log(`${unique.length} tool name(s) named in shipped prompts/skills do not exist:\n`);
for (const name of unique) {
  console.log(`  ${name}`);
  for (const g of ghosts.filter((x) => x.name === name)) {
    console.log(`      ${g.file}:${g.line}`);
  }
}
console.log('\nEither implement them or stop naming them. A prompt is read every');
console.log('time, so a phantom tool costs a failed call on every single task.');

process.exit(process.argv.includes('--check') ? 1 : 0);
