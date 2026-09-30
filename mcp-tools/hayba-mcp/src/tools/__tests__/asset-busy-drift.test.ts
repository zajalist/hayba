/**
 * asset_busy (P0 T3) refuses editor_start_pie and editor_save_all_and_quit
 * while any owner holds an asset build lease. It also refuses the compile or
 * save of one asset while another owner builds it. The tables live in
 * HaybaMCPEditorStatePolicy.h. A misspelt command or field fails nothing at
 * runtime: the command would silently skip the gate and compile a half-built
 * asset (the consumer's I-6 path). The native test
 * Hayba.MCP.State.AssetBusyTargets checks the same rows against the live
 * router. This one runs in the local gate and fails closed.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PRIVATE = join(process.cwd(), '../../unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private');
const POLICY = join(PRIVATE, 'HaybaMCPEditorStatePolicy.h');
const HANDLERS = join(PRIVATE, 'handlers');

const EXPECTED_TARGETS: Record<string, string[]> = {
  anim_blueprint_compile: ['path'],
  audio_asset_save: ['path'],
  blueprint_compile: ['path'],
  bt_compile: ['path'],
  material_compile: ['material_path', 'function_path'],
  ui_compile_widget: ['widget_blueprint_path'],
  ui_save_widget: ['widget_blueprint_path'],
};

function slice(src: string, signature: string, end: string): string {
  const start = src.indexOf(signature);
  expect(start, `${signature} not found in HaybaMCPEditorStatePolicy.h - was it renamed?`).toBeGreaterThan(-1);
  const stop = src.indexOf(end, start);
  expect(stop, `${end} not found after ${signature}`).toBeGreaterThan(start);
  return src.slice(start, stop);
}

function busyTargets(src: string): Record<string, string[]> {
  const table = slice(src, 'inline const TMap<FString, TArray<FString>>& AssetBusyTargets()', 'return Targets;');
  const rows: Record<string, string[]> = {};
  for (const m of table.matchAll(/\{\s*TEXT\("([a-z_]+)"\)\s*,\s*\{([^}]*)\}\s*\}/g)) {
    rows[m[1]!] = [...m[2]!.matchAll(/TEXT\("([a-z_]+)"\)/g)].map((f) => f[1]!);
  }
  return rows;
}

function anyBusy(src: string): string[] {
  const table = slice(src, 'inline const TSet<FString>& AnyBusyCommands()', 'return Commands;');
  return [...table.matchAll(/TEXT\("([a-z_]+)"\)/g)].map((m) => m[1]!);
}

function handlerSources(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readdirSync(HANDLERS)) {
    if (f.endsWith('.cpp')) out.set(f, readFileSync(join(HANDLERS, f), 'utf-8'));
  }
  return out;
}

/** Handler .cpp files that carry a TEXT("<cmd>") literal. */
function handlersNaming(cmd: string, sources: Map<string, string>): string[] {
  return [...sources.entries()].filter(([, text]) => text.includes(`TEXT("${cmd}")`)).map(([file]) => file);
}

describe('asset_busy tables name real commands and the fields their handlers read', () => {
  it('finds the policy header and the handler sources', () => {
    expect(existsSync(POLICY), POLICY).toBe(true);
    expect(handlerSources().size).toBeGreaterThanOrEqual(30);
  });

  it('pins the AssetBusyTargets rows (spec T3 design 3)', () => {
    expect(busyTargets(readFileSync(POLICY, 'utf-8'))).toEqual(EXPECTED_TARGETS);
  });

  it('every busy target is named by a handler that reads its field', () => {
    const sources = handlerSources();
    const rows = Object.entries(busyTargets(readFileSync(POLICY, 'utf-8')));
    expect(rows.length).toBe(7);
    for (const [cmd, fields] of rows) {
      const files = handlersNaming(cmd, sources);
      expect(files, `${cmd} is not named by any handler`).not.toEqual([]);
      for (const field of fields) {
        expect(
          files.some((f) => sources.get(f)!.includes(`TEXT("${field}")`)),
          `${cmd}: no handler naming it reads '${field}'`,
        ).toBe(true);
      }
    }
  });

  it('AnyBusyCommands are exactly editor_start_pie and editor_save_all_and_quit, both registered', () => {
    const names = anyBusy(readFileSync(POLICY, 'utf-8'));
    expect([...names].sort()).toEqual(['editor_save_all_and_quit', 'editor_start_pie']);
    const sources = handlerSources();
    for (const cmd of names) expect(handlersNaming(cmd, sources), cmd).not.toEqual([]);
  });
});
