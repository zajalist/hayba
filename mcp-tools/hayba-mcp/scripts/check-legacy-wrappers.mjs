// CI lint: enforce that the legacy-command sidecar.json matches the truth
// in HaybaMCPLegacyHandler.cpp and the actual TS wrapper surface.
//
// Three invariants:
//   1. Every command name from the .cpp GetCommands() list has a sidecar entry.
//      [missing-sidecar]
//   2. Every sidecar entry with has_ts_wrapper:true has at least one
//      executeCommand('<name>', ...) or dispatch('<name>', ...) call under
//      mcp-tools/hayba-mcp/src/tools/**/*.ts (non-test files).
//      [missing-wrapper]
//   3. Every sidecar entry with has_ts_wrapper:false has NO such call.
//      [stale-flag]
//
// Run via:
//   npm run lint:legacy-wrappers
// or import { runLegacyWrapperCheck } from this file (vitest does this).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve project anchors relative to this file so the script works
// regardless of cwd (vitest runs from package root, manual invocation
// might run from elsewhere).
const PKG_ROOT = join(__dirname, '..');
const REPO_ROOT = join(PKG_ROOT, '..', '..');
const SIDECAR_PATH = join(PKG_ROOT, 'src', 'legacy-commands', 'sidecar.json');
const LEGACY_CPP_PATH = join(
  REPO_ROOT,
  'unreal',
  'HaybaMCPToolkit',
  'Source',
  'HaybaMCPToolkit',
  'Private',
  'handlers',
  'HaybaMCPLegacyHandler.cpp',
);
const TS_TOOLS_ROOT = join(PKG_ROOT, 'src', 'tools');

/**
 * Pull every TEXT("...") literal inside GetCommands() — that's the
 * authoritative dispatch table. Format is stable: a `return { TEXT("a"),
 * TEXT("b"), ... };` block inside the GetCommands() method.
 */
export function extractCppCommands(cppSource) {
  const startIdx = cppSource.indexOf('::GetCommands()');
  if (startIdx === -1) throw new Error('Could not find ::GetCommands() in legacy cpp');
  // Find the next `return {` after the signature and walk to the matching `};`.
  const returnIdx = cppSource.indexOf('return {', startIdx);
  if (returnIdx === -1) throw new Error('Could not find `return {` block in GetCommands()');
  const endIdx = cppSource.indexOf('};', returnIdx);
  if (endIdx === -1) throw new Error('Could not find `};` closing GetCommands() return');
  const block = cppSource.slice(returnIdx, endIdx);
  const names = new Set();
  const re = /TEXT\("([^"]+)"\)/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    names.add(m[1]);
  }
  return names;
}

/**
 * Walk TS_TOOLS_ROOT for .ts files that are NOT test files, and collect
 * every first-arg string literal from calls of the form
 *   executeCommand('<name>', ...)   OR
 *   dispatch('<name>', ...)         // used by asset-retriever
 * Both single and double quotes are supported.
 *
 * Returns Map<commandName, file[]>.
 */
export function collectTsWrapperCalls(toolsRoot) {
  const calls = new Map();
  function addHit(name, file) {
    if (!calls.has(name)) calls.set(name, []);
    calls.get(name).push(file);
  }
  function visit(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        // Skip __tests__ and node_modules just in case.
        if (entry === '__tests__' || entry === 'node_modules') continue;
        visit(full);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      // Skip *.test.ts — wrappers under test count as "fake calls" we
      // don't want to satisfy the lint with.
      if (entry.endsWith('.test.ts')) continue;
      const src = readFileSync(full, 'utf-8');
      // Match executeCommand(...) / dispatch(...) / ueTool(...) with optional
      // generic type args between the identifier and `(`, e.g.
      //   executeCommand<Record<string, unknown>>('get_node_details', ...).
      // Generics can nest one level (Record<string, unknown>), so we
      // permit one nested pair inside the outer <...>.
      //
      // ueTool('<name>', schema) is the pass-through wrapper form. It calls
      // executeCommand internally, so scanning for executeCommand alone still
      // *passes* — it just stops seeing every wrapper that uses the helper.
      // When the six editor_pie_* wrappers moved to ueTool this linter reported
      // them as missing rather than as covered, which is the visible half of
      // the same blindness; the invisible half is a wrapper that quietly drops
      // out of the check entirely.
      const re =
        /\b(?:executeCommand|dispatch|ueTool)(?:\s*<(?:[^<>]|<[^<>]*>)*>)?\s*\(\s*['"]([^'"]+)['"]/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        addHit(m[1], full);
      }
    }
  }
  visit(toolsRoot);
  return calls;
}

export function runLegacyWrapperCheck(opts = {}) {
  const sidecarPath = opts.sidecarPath ?? SIDECAR_PATH;
  const cppPath = opts.cppPath ?? LEGACY_CPP_PATH;
  const toolsRoot = opts.toolsRoot ?? TS_TOOLS_ROOT;

  const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
  const cppSource = readFileSync(cppPath, 'utf-8');
  const cppCommands = extractCppCommands(cppSource);
  const tsCalls = collectTsWrapperCalls(toolsRoot);

  const violations = [];
  const sidecarNames = new Set(Object.keys(sidecar.commands));

  // Invariant 1: every cpp command has a sidecar entry.
  for (const cmd of cppCommands) {
    if (!sidecarNames.has(cmd)) {
      violations.push(
        `[missing-sidecar] command "${cmd}" exists in HaybaMCPLegacyHandler.cpp but has no entry in sidecar.json`,
      );
    }
  }

  // Invariants 2 & 3: TS wrapper flag matches reality.
  // Match against the entry name OR any alias — a TS wrapper that calls
  // executeCommand('execute_graph') legitimately covers the sidecar
  // entry for 'pcg_execute_graph' (they route to the same handler), so
  // we treat aliases as equivalent for wrapper-detection purposes.
  for (const [name, entry] of Object.entries(sidecar.commands)) {
    const aliasGroup = [name, ...(entry.aliases ?? [])];
    const hitFiles = aliasGroup.flatMap((n) => tsCalls.get(n) ?? []);
    const hasCall = hitFiles.length > 0;
    if (entry.has_ts_wrapper && !hasCall) {
      violations.push(
        `[missing-wrapper] sidecar says "${name}" has a TS wrapper but no executeCommand/dispatch call found in src/tools/ (also checked aliases: ${aliasGroup.slice(1).join(', ') || '(none)'})`,
      );
    } else if (!entry.has_ts_wrapper && hasCall) {
      const uniq = Array.from(new Set(hitFiles));
      violations.push(
        `[stale-flag] sidecar says "${name}" has no TS wrapper but executeCommand/dispatch call found in ${uniq.join(', ')}. If this command is surfaced by src/tools/legacy-tool-factory.ts (agent_callable && !has_ts_wrapper), either keep dispatch dynamic or set has_ts_wrapper:true.`,
      );
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    cppCommandCount: cppCommands.size,
    sidecarCommandCount: sidecarNames.size,
  };
}

// CLI entrypoint.
const isMain = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();
if (isMain) {
  const res = runLegacyWrapperCheck();
  if (res.ok) {
    console.log(
      `[lint:legacy-wrappers] OK — ${res.cppCommandCount} cpp commands, ${res.sidecarCommandCount} sidecar entries, no violations.`,
    );
    process.exit(0);
  } else {
    console.error(
      `[lint:legacy-wrappers] FAIL — ${res.violations.length} violation(s):`,
    );
    for (const v of res.violations) {
      console.error(`  ${v}`);
    }
    process.exit(1);
  }
}
