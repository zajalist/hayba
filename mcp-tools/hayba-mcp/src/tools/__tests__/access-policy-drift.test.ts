/**
 * The lease classification tables must name real plugin commands.
 *
 * HaybaMCPAccessPolicy.h lists WriteWorld and Global commands by name. A typo
 * there does not fail anything at runtime: the misspelt command silently falls
 * back to its derived class (WriteScoped or Read), so a map load could run
 * under another agent's world lease. That is exactly how the Plan-Mode gate
 * once let console commands through ("editor_execute_console" for
 * "editor_run_console_command"). The native test
 * Hayba.MCP.Lease.ClassificationDrift checks the same thing against the live
 * router, but needs an editor; this one runs in the local gate.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PRIVATE = join(process.cwd(), '../../unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private');
const POLICY = join(PRIVATE, 'HaybaMCPAccessPolicy.h');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function tableNames(src: string, fn: string): string[] {
  const start = src.indexOf(`inline const TSet<FString>& ${fn}()`);
  expect(start, `${fn}() not found in HaybaMCPAccessPolicy.h - was it renamed?`).toBeGreaterThan(-1);
  const end = src.indexOf('};', start);
  return [...src.slice(start, end).matchAll(/TEXT\("([^"]+)"\)/g)].map((m) => m[1]!);
}

/** Command names from handler GetCommands() literals (handler .cpp files only). */
function handlerCommands(): Set<string> {
  const cmds = new Set<string>();
  for (const f of walk(join(PRIVATE, 'handlers'))) {
    if (!f.endsWith('.cpp')) continue;
    for (const m of readFileSync(f, 'utf-8').matchAll(/TEXT\("([a-z][a-z0-9_]{2,})"\)/g)) cmds.add(m[1]!);
  }
  return cmds;
}

describe('lease access-class tables name real commands', () => {
  const available = existsSync(POLICY);

  it.runIf(available)('every WriteWorld and Global entry is a handler command', () => {
    const src = readFileSync(POLICY, 'utf-8');
    const named = [...tableNames(src, 'WriteWorldCommands'), ...tableNames(src, 'GlobalCommands')];
    expect(named.length).toBeGreaterThan(5);
    const known = handlerCommands();
    expect(named.filter((cmd) => !known.has(cmd)).sort()).toEqual([]);
  });

  it.runIf(available)('keeps the commands the design names in their classes', () => {
    const src = readFileSync(POLICY, 'utf-8');
    const world = tableNames(src, 'WriteWorldCommands');
    const global = tableNames(src, 'GlobalCommands');
    for (const cmd of ['level_save', 'wp_load_cell']) expect(world).toContain(cmd);
    for (const cmd of ['level_load', 'level_create', 'editor_save_all_and_quit', 'editor_run_console_command']) {
      expect(global).toContain(cmd);
    }
  });
});
