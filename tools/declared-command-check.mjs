#!/usr/bin/env node
// Every command a handler DECLARES must be implemented in its Handle() body.
//
// `GetCommands()` is the advertisement: it feeds the capability inventory, the
// generated CAPABILITIES.md, and the router's dispatch table. `Handle()` is the
// implementation. Nothing checked that the two agree, so a command could be
// listed for agents, routed to its handler, and fall through to that handler's
// own "unknown command" tail — advertised, reachable, and broken. An agent
// hitting it would read "unknown command" for a command the catalogue promised,
// and reasonably conclude the plugin was out of date.
//
// The check is a heuristic: Handle() bodies are hand-written C++ with varied
// shapes, so it looks for the command string appearing in the file outside the
// GetCommands() block, ignoring comment lines. Two handlers legitimately do not
// name their command in the body; they are listed below with the reason, rather
// than the check being loosened to accommodate them silently.
//
//   node tools/declared-command-check.mjs
//   node tools/declared-command-check.mjs --check   (same; exits 1 on a miss)

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const H = join(ROOT, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private', 'handlers');

/**
 * Commands whose handler dispatches without naming them. Each entry is a
 * verified reading of that Handle() body, not a suppression.
 */
const DISPATCHES_WITHOUT_NAMING = new Map([
  // Two commands, one body: `wait_for_shaders` is the explicit branch and
  // `wait_for_idle` is the else, so the newer name never appears as a literal.
  ['wait_for_idle', 'HaybaMCPIdleHandler.cpp — handled as the else branch of wait_for_shaders'],
  // Sole command of its handler; the body signature is `Handle(const FString&
  // /*Command*/, ...)` because there is nothing to branch on.
  ['render_camera', 'HaybaMCPRenderHandler.cpp — sole command, Command parameter deliberately unused'],
]);

const files = readdirSync(H).filter((f) => f.endsWith('.cpp')).map((f) => join(H, f));

let declaredCount = 0;
const problems = [];
const excused = [];

for (const file of files) {
  const src = readFileSync(file, 'utf8');

  const gc = src.match(/GetCommands\(\)\s*const\s*\{([\s\S]*?)\n\}/);
  if (!gc) continue;
  const declared = [...gc[1].matchAll(/TEXT\("([a-z0-9_]+)"\)/gi)].map((m) => m[1]);
  if (declared.length === 0) continue;
  declaredCount += declared.length;

  const rest = src.slice(0, gc.index) + src.slice(gc.index + gc[0].length);
  const code = rest
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  for (const cmd of declared) {
    if (code.includes(`"${cmd}"`)) continue;
    if (DISPATCHES_WITHOUT_NAMING.has(cmd)) {
      excused.push(cmd);
      continue;
    }
    problems.push(
      `${basename(file)}: declares "${cmd}" in GetCommands() but never names it in ` +
        `Handle() — it would be advertised to agents and answer "unknown command"`,
    );
  }
}

if (declaredCount < 100) {
  console.error(
    `declared-command-check: only found ${declaredCount} declared commands — the ` +
      'GetCommands() shape probably changed, so this check is no longer checking anything',
  );
  process.exit(1);
}

if (problems.length > 0) {
  console.error('declared commands with no implementation:\n');
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nImplement it, or remove it from GetCommands().');
  process.exit(1);
}

console.error(
  `ok: all ${declaredCount} declared command(s) are implemented ` +
    `(${excused.length} dispatch without naming themselves, by design)`,
);
