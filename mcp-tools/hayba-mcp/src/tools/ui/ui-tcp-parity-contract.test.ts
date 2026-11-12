/**
 * The UI lane called ui_set_text_style through hayba_call (Hayba's TCP path) and got "Unknown command": the MCP
 * server's ui_* convenience tools were TypeScript-only wrappers, so it rewrote Font sizes by regex and the first try
 * clobbered OutlineSize. Every ui_* MCP tool must also be a native command, except the composites that run several
 * commands from TypeScript, listed here on purpose.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..', '..', '..', '..', 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private');
const native = [
  readFileSync(join(src, 'handlers', 'HaybaMCPUIHandler.cpp'), 'utf8'),
  readFileSync(join(src, 'HaybaUIOps.cpp'), 'utf8'),
].join('\n');
const tsIndex = readFileSync(join(here, '..', 'index.ts'), 'utf8');
const tsTools = [...new Set([...tsIndex.matchAll(/name: '(ui_[a-z_]+)'/g)].map((m) => m[1]!))];

// Composites: several native calls stitched together in TypeScript (snapshot, then per-widget writes or rules).
const MCP_ONLY = new Set(['ui_copy_style', 'ui_set_default_font', 'ui_validate']);
// MCP tools whose native command has another name; over TCP they are reached by that name.
const NATIVE_NAME: Record<string, string> = { ui_bind_event: 'blueprint_add_bound_event' };
const blueprintNative = readFileSync(join(src, 'handlers', 'HaybaMCPBlueprintHandler.cpp'), 'utf8');

describe('every ui_* MCP tool answers over TCP too', () => {
  it('finds the MCP tools', () => {
    expect(tsTools.length).toBeGreaterThan(20);
    expect(tsTools).toContain('ui_set_text_style');
  });

  for (const name of tsTools.filter((n) => !MCP_ONLY.has(n))) {
    it(`${name} is a native command`, () => {
      const nativeName = NATIVE_NAME[name];
      if (nativeName) expect(blueprintNative).toContain(`TEXT("${nativeName}")`);
      else expect(native).toContain(`TEXT("${name}")`);
    });
  }
});
