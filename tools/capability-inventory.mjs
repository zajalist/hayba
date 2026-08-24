#!/usr/bin/env node
//
// One source of truth for "what can the agent actually do".
//
// The surface is currently countable four incompatible ways -- commands
// declared in C++ GetCommands(), commands described in sidecar.json, tool
// descriptors in the TS catalogue, and files under src/tools/ -- and none of
// them is derived from another, so they drift and the published numbers drift
// with them. This derives the C++ side from the source that actually defines
// it, diffs it against the descriptors the MCP server reads, and writes the
// result down.
//
// Usage:
//   node tools/capability-inventory.mjs            write docs/CAPABILITIES.md
//   node tools/capability-inventory.mjs --check     fail on drift (CI)
//   node tools/capability-inventory.mjs --json      machine-readable dump
//
// Deliberately a *parser*, not a runtime probe: it must work with no editor
// running and no plugin built. The tradeoff is that it sees what the source
// declares rather than what a live plugin registers -- if a handler is compiled
// out or never registered, this will not know. The registration list in
// HaybaMCPModule.cpp is cross-checked for exactly that reason.

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(ROOT, 'unreal');
const SIDECAR = join(ROOT, 'mcp-tools/hayba-mcp/src/legacy-commands/sidecar.json');
const OUT = join(ROOT, 'docs/CAPABILITIES.md');

const CHECK = process.argv.includes('--check');
const JSON_OUT = process.argv.includes('--json');

/**
 * Commands that are unreachable on purpose, with the reason.
 *
 * A gate that fires on deliberate omissions gets switched off, and then it
 * protects nothing. Every entry here is a decision, not an oversight, so adding
 * one should feel like a small argument you have to make in writing.
 */
const INTENTIONALLY_UNREACHABLE = new Map([
  ['copilot_get_key', 'credential retrieval — the agent must never be able to read a stored key'],
  ['editor_get_perf_stats',
    'orphan duplicate: FHaybaMCPPerfHandler declares it while FHaybaMCPEditorHandler ' +
    'implements editor_get_performance_stats, which is the one described and used. ' +
    'Needs a decision (delete the duplicate, or merge and expose) rather than a descriptor.'],
]);

/** Every handler .cpp/.h pair across the toolkit and its satellite modules. */
function handlerSources() {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Build output is not source and contains generated copies that would
        // double-count.
        if (entry.name === 'Intermediate' || entry.name === 'Binaries') continue;
        walk(p);
      } else if (entry.name.endsWith('.cpp') || entry.name.endsWith('.h')) {
        out.push(p);
      }
    }
  };
  walk(PLUGIN);
  return out;
}

/**
 * Commands declared in a GetCommands() body.
 *
 * Matching the body rather than the whole file matters: handler files are full
 * of TEXT("...") literals for error messages, JSON field names, and asset
 * paths, and a naive file-wide grep over-counts by an order of magnitude. An
 * earlier pass of this analysis reported 1688 "commands" that way.
 */
function commandsFrom(src) {
  const found = new Set();
  const re = /GetCommands\s*\([^)]*\)\s*const\s*(?:override\s*)?\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    for (const lit of m[1].matchAll(/TEXT\("([a-z][a-z0-9_]*)"\)/g)) found.add(lit[1]);
  }
  return found;
}

/** `virtual FString GetDomain() const override { return TEXT("build"); }` */
function domainFrom(src) {
  const m = src.match(/GetDomain\s*\([^)]*\)\s*const\s*(?:override\s*)?\{\s*return\s+TEXT\("([^"]+)"\)/);
  return m ? m[1] : null;
}

function collectDeclared() {
  const byClass = new Map(); // class -> { domain, commands:Set, files:Set }
  for (const file of handlerSources()) {
    const src = readFileSync(file, 'utf-8');

    const cmds = commandsFrom(src);
    const domain = domainFrom(src);
    if (cmds.size === 0 && !domain) continue;

    // Class name from the definition or the declaration, else the filename.
    const cm =
      src.match(/([A-Za-z_]\w*)::GetCommands\s*\(/) ||
      src.match(/class\s+(?:\w+_API\s+)?([A-Za-z_]\w*)\s*:\s*public\s+IHaybaMCPHandler/);
    const cls = cm ? cm[1] : basename(file).replace(/\.(cpp|h)$/, '');

    const entry = byClass.get(cls) ?? { domain: null, commands: new Set(), files: new Set() };
    if (domain) entry.domain = domain;
    for (const c of cmds) entry.commands.add(c);
    entry.files.add(file.slice(ROOT.length + 1).replace(/\\/g, '/'));
    byClass.set(cls, entry);
  }
  // A header-only match with no commands anywhere is not a handler.
  for (const [cls, e] of byClass) if (e.commands.size === 0) byClass.delete(cls);
  return byClass;
}

/** Handlers the module actually registers, so "declared" can be distinguished
 *  from "reachable". */
function registeredClasses() {
  const modulePath = join(PLUGIN, 'HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPModule.cpp');
  if (!existsSync(modulePath)) return null;
  const src = readFileSync(modulePath, 'utf-8');
  const out = new Set();
  for (const m of src.matchAll(/MakeShared<\s*([A-Za-z_]\w*)\s*>/g)) out.add(m[1]);
  return out;
}

/**
 * Commands referenced anywhere in the TS server.
 *
 * Absence from sidecar.json does NOT mean unreachable: many commands have a
 * hand-written TS wrapper instead (actor_spawn, actor_list and friends go
 * through src/tools/actor/). Gating CI on "not in sidecar" alone would fail on
 * ~80 commands that work fine. A command is only genuinely undiscoverable when
 * neither the descriptors nor any wrapper mentions it.
 *
 * This is a text scan, so it over-approximates: a command named in a comment
 * counts as referenced. That bias is deliberate -- a false "reachable" leaves
 * the gate quiet, a false "unreachable" cries wolf and gets the gate disabled.
 */
function tsReferenced() {
  const SRC = join(ROOT, 'mcp-tools/hayba-mcp/src');
  if (!existsSync(SRC)) return null;
  const seen = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      if (entry.name.endsWith('.test.ts')) continue; // tests name dead commands on purpose
      const src = readFileSync(p, 'utf-8');
      for (const m of src.matchAll(/['"`]([a-z][a-z0-9_]{2,})['"`]/g)) seen.add(m[1]);
    }
  };
  walk(SRC);
  return seen;
}

function sidecarCommands() {
  if (!existsSync(SIDECAR)) return null;
  const raw = JSON.parse(readFileSync(SIDECAR, 'utf-8'));
  const cmds = raw.commands ?? raw;
  const all = new Set(Object.keys(cmds));
  const callable = new Set(
    Object.entries(cmds).filter(([, v]) => v && typeof v === 'object' && v.agent_callable).map(([k]) => k)
  );
  return { all, callable };
}

function main() {
  const declared = collectDeclared();
  const registered = registeredClasses();
  const sidecar = sidecarCommands();

  const allDeclared = new Set();
  for (const e of declared.values()) for (const c of e.commands) allDeclared.add(c);

  const tsSeen = tsReferenced();
  const undescribed = sidecar ? [...allDeclared].filter(c => !sidecar.all.has(c)).sort() : [];
  // The gate's real question: can an agent reach this at all?
  const unreachableAll = sidecar
    ? undescribed.filter(c => !(tsSeen && tsSeen.has(c))).sort()
    : [];
  const unreachable = unreachableAll.filter(c => !INTENTIONALLY_UNREACHABLE.has(c));
  const deliberate = unreachableAll.filter(c => INTENTIONALLY_UNREACHABLE.has(c));
  // An allowlist entry for something now reachable is stale and should go.
  const staleAllowlist = [...INTENTIONALLY_UNREACHABLE.keys()]
    .filter(c => !unreachableAll.includes(c)).sort();
  const wrappedOnly = undescribed.filter(c => tsSeen && tsSeen.has(c)).sort();
  const unimplemented = sidecar ? [...sidecar.all].filter(c => !allDeclared.has(c)).sort() : [];
  const unregistered = registered
    ? [...declared.keys()].filter(c => !registered.has(c)).sort()
    : [];

  if (JSON_OUT) {
    console.log(JSON.stringify({
      handlers: declared.size,
      commands: allDeclared.size,
      sidecarDescribed: sidecar?.all.size ?? null,
      sidecarCallable: sidecar?.callable.size ?? null,
      undescribed, unimplemented, unregistered,
      byHandler: Object.fromEntries([...declared].map(([k, v]) =>
        [k, { domain: v.domain, commands: [...v.commands].sort() }])),
    }, null, 2));
    return;
  }

  if (CHECK) {
    const problems = [];
    if (unreachable.length) {
      problems.push(`${unreachable.length} command(s) declared in C++ with no sidecar descriptor and no TS ` +
        `reference (an agent cannot reach these at all): ${unreachable.slice(0, 8).join(', ')}${unreachable.length > 8 ? ' ...' : ''}`);
    }
    if (unimplemented.length) {
      problems.push(`${unimplemented.length} command(s) described in sidecar.json with no C++ declaration ` +
        `(these fail at call time): ${unimplemented.slice(0, 8).join(', ')}${unimplemented.length > 8 ? ' ...' : ''}`);
    }
    if (staleAllowlist.length) {
      problems.push(`${staleAllowlist.length} allowlist entr(ies) in INTENTIONALLY_UNREACHABLE are now ` +
        `reachable and should be removed: ${staleAllowlist.join(', ')}`);
    }
    if (problems.length) {
      for (const p of problems) console.error(`drift: ${p}`);
      console.error('\nregenerate with: node tools/capability-inventory.mjs');
      process.exit(1);
    }
    console.log(
      `ok: ${allDeclared.size} declared commands across ${declared.size} handlers; ` +
      `${deliberate.length} intentionally unreachable, everything else reachable`
    );
    return;
  }

  const rows = [...declared.entries()]
    .sort((a, b) => (a[1].domain ?? a[0]).localeCompare(b[1].domain ?? b[0]))
    .map(([cls, e]) => {
      const reachable = registered ? (registered.has(cls) ? 'yes' : '**no**') : '?';
      return `| \`${e.domain ?? '—'}\` | ${cls} | ${e.commands.size} | ${reachable} |`;
    });

  const md = `# Capabilities

Generated by \`tools/capability-inventory.mjs\` from the C++ that declares the
commands. **Do not edit by hand** — regenerate.

This exists because the tool surface was countable four incompatible ways and
none of the counts was derived from another, so the published numbers drifted.
The number below is the one with a definition: commands declared in a
\`GetCommands()\` body in plugin source.

## Totals

| What | Count |
|---|---|
| Handler classes declaring commands | **${declared.size}** |
| Commands declared in C++ | **${allDeclared.size}** |
| Commands described in \`sidecar.json\` | ${sidecar ? sidecar.all.size : 'n/a'} |
| …of those, marked agent-callable | ${sidecar ? sidecar.callable.size : 'n/a'} |

${unreachable.length ? `### Unreachable (${unreachable.length})

No \`sidecar.json\` descriptor and no reference anywhere in the TS server. The
MCP server reads \`sidecar.json\` at startup, so these are reachable only by an
agent guessing the exact command name. **This is what the CI gate fails on.**

${unreachable.map(c => `- \`${c}\``).join('\n')}
` : '_Every declared command is either described in `sidecar.json` or wrapped in TS._\n'}
${deliberate.length ? `### Unreachable on purpose (${deliberate.length})

Allowlisted in \`tools/capability-inventory.mjs\`. The gate ignores these.

${deliberate.map(c => `- \`${c}\` — ${INTENTIONALLY_UNREACHABLE.get(c)}`).join('\n')}
` : ''}
${wrappedOnly.length ? `### Wrapped in TS, absent from \`sidecar.json\` (${wrappedOnly.length})

Reachable through a hand-written TS tool rather than a legacy descriptor, so
these work — but the sidecar count under-reports the real surface by this much,
which is one of the reasons the published numbers never agreed.

<details><summary>${wrappedOnly.length} commands</summary>

${wrappedOnly.map(c => `- \`${c}\``).join('\n')}

</details>
` : ''}
${unimplemented.length ? `### Described but not declared (${unimplemented.length})

These will fail at call time. Either the handler moved, or the descriptor
outlived it.

${unimplemented.map(c => `- \`${c}\``).join('\n')}
` : ''}
${unregistered.length ? `### Declared but never registered (${unregistered.length})

The class declares commands but does not appear in \`HaybaMCPModule.cpp\`'s
registration list. Satellite-module handlers register themselves via
\`RegisterExternalHandler\` and are expected here.

${unregistered.map(c => `- \`${c}\``).join('\n')}
` : ''}
## By handler

| Domain | Class | Commands | Registered in module |
|---|---|---:|---|
${rows.join('\n')}
`;

  writeFileSync(OUT, md);
  console.log(`wrote ${OUT.slice(ROOT.length + 1)} — ${allDeclared.size} commands, ${declared.size} handlers`);
  if (undescribed.length) console.log(`  ${undescribed.length} declared but not described`);
  if (unimplemented.length) console.log(`  ${unimplemented.length} described but not declared`);
}

main();
