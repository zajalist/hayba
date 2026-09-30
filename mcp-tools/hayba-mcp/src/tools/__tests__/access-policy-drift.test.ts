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

  // Asset writers lock asset:<path> from their own request. A misspelt entry
  // would fall back to the world intent lock and two agents could edit one
  // AnimBP at once.
  it.runIf(available)('every AssetWrite entry is a handler command keyed by a request field', () => {
    const src = readFileSync(POLICY, 'utf-8');
    const start = src.indexOf('inline const TMap<FString, FString>& AssetWriteCommands()');
    expect(start, 'AssetWriteCommands() not found in HaybaMCPAccessPolicy.h - was it renamed?').toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('};', start));
    const pairs = [...body.matchAll(/\{\s*TEXT\("([^"]+)"\),\s*TEXT\("([^"]+)"\)\s*\}/g)].map((m) => [m[1]!, m[2]!] as const);
    expect(pairs.length).toBeGreaterThan(5);
    const known = handlerCommands();
    expect(pairs.map(([cmd]) => cmd).filter((cmd) => !known.has(cmd)).sort()).toEqual([]);
    for (const [cmd, field] of pairs) expect(field, cmd).toMatch(/^[a-z_]+$/);
  });

  // Spec T3 design 1: this branch carries the Blueprint and widget rows only.
  // The deploy branch's animation rows arrive by merge (spec 7.3), which must
  // update this pin to the union.
  it.runIf(available)('pins the S1 rows: Blueprint writers by path, widget writers by widget_blueprint_path', () => {
    const src = readFileSync(POLICY, 'utf-8');
    const start = src.indexOf('inline const TMap<FString, FString>& AssetWriteCommands()');
    expect(start, 'AssetWriteCommands() not found').toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('};', start));
    const rows = Object.fromEntries(
      [...body.matchAll(/\{\s*TEXT\("([^"]+)"\),\s*TEXT\("([^"]+)"\)\s*\}/g)].map((m) => [m[1]!, m[2]!]),
    );
    expect(rows).toEqual({
      blueprint_add_node: 'path',
      blueprint_connect_nodes: 'path',
      blueprint_set_pin_default: 'path',
      blueprint_add_variable: 'path',
      blueprint_add_function: 'path',
      blueprint_add_event: 'path',
      blueprint_compile: 'path',
      ui_build_tree: 'widget_blueprint_path',
      ui_mutate_tree: 'widget_blueprint_path',
      ui_set_variable: 'widget_blueprint_path',
      ui_set_widget_properties: 'widget_blueprint_path',
      ui_add_element: 'widget_blueprint_path',
      ui_bind_property: 'widget_blueprint_path',
      ui_compile_widget: 'widget_blueprint_path',
      ui_save_widget: 'widget_blueprint_path',
    });
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
