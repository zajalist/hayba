// CI lint: forbid raw `AsyncTask(ENamedThreads::GameThread, ...)` in plugin
// code, with an allowlist for the dispatcher implementation itself.
//
// The plugin must funnel all game-thread marshaling through
// HaybaThreading::ExecuteOnGameThread / RunOnGameThreadAndWait — those
// helpers use a FCoreDelegates::OnEndFrame-driven queue instead of UE's
// TaskGraph queue, which sidesteps the
//   Assertion failed: ++Queue(QueueIndex).RecursionGuard == 1
//   TaskGraph.cpp:689
// crash when a handler invoked via AsyncTask itself calls AsyncTask
// (re-entrant push). Two MCP sessions in May 2026 hit this; the fix is
// architectural (single dispatcher) and this lint keeps it from
// regressing.
//
// Allowlisted files (where raw AsyncTask is intentional):
//   - HaybaMCPThreading.cpp  — IS the dispatcher
//   - HaybaMCPTcpServer.cpp  — uses AsyncTask for the BACKGROUND worker pool
//                              (ENamedThreads::AnyBackgroundThreadNormalTask),
//                              never for GameThread

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..', '..', '..', 'unreal', 'HaybaMCPToolkit', 'Source');

// Files allowed to call AsyncTask(GameThread) directly. Add new entries
// only with a documented reason in the file itself.
const ALLOWLIST = new Set([
  ['HaybaMCPToolkit', 'Private', 'HaybaMCPThreading.cpp'].join(sep),
]);

const PATTERN = /AsyncTask\s*\(\s*ENamedThreads::GameThread/;

function walk(dir, hits) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) { walk(full, hits); continue; }
    if (!/\.(cpp|h)$/.test(entry)) continue;
    const src = readFileSync(full, 'utf-8');
    const lines = src.split(/\r?\n/);
    // Track whether we're inside a block comment across lines.
    let inBlockComment = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      // Block comment handling — be conservative, may over-skip but
      // that's safe (we don't want false positives flagging commentary).
      if (inBlockComment) {
        if (line.includes('*/')) inBlockComment = false;
        continue;
      }
      if (/\/\*/.test(line) && !/\*\//.test(line)) {
        inBlockComment = true;
        continue;
      }
      // Single-line comments + Doxygen `*` continuation lines.
      if (/^\s*\/\//.test(trimmed)) continue;
      if (/^\s*\*/.test(trimmed)) continue;
      if (PATTERN.test(line)) {
        hits.push({ file: full, line: i + 1, text: trimmed });
      }
    }
  }
}

const hits = [];
walk(PLUGIN_ROOT, hits);

const violations = hits.filter((h) => {
  const rel = relative(PLUGIN_ROOT, h.file);
  return !ALLOWLIST.has(rel);
});

if (violations.length === 0) {
  const allowlisted = hits.length;
  console.log(
    `[lint:no-raw-asynctask-gamethread] OK — ${allowlisted} raw AsyncTask(GameThread) call(s), all allowlisted.`,
  );
  process.exit(0);
}

console.error(
  `[lint:no-raw-asynctask-gamethread] FAIL — ${violations.length} raw AsyncTask(GameThread) call(s) outside allowlist:`,
);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}`);
  console.error(`    ${v.text}`);
}
console.error('');
console.error('  Fix: call HaybaThreading::ExecuteOnGameThread(...) (fire-and-forget)');
console.error('  or HaybaThreading::RunOnGameThreadAndWait(...) (blocking) instead.');
console.error('  Raw AsyncTask(GameThread, ...) re-enters UE TaskGraph queue and crashes when');
console.error('  the caller is already on the game thread (RecursionGuard assert).');
process.exit(1);
