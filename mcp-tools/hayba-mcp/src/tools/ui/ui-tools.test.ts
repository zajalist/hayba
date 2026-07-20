import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryToolExecutor, setDefaultSender } from '../tool-executor.js';
import { inferDir } from '../index.js';
import { deriveDomainPacks } from '../routing/pack-discovery.js';
import { uiCreateWidgetHandler } from './ui-create-widget.js';
import { uiAddElementHandler } from './ui-add-element.js';
import { uiQueryHandler } from './ui-query.js';

const UI_TOOLS = ['ui_create_widget', 'ui_add_element', 'ui_query'] as const;

/**
 * Smoke test for the three UMG / Widget Blueprint wrapper tools:
 * - ui_create_widget
 * - ui_add_element
 * - ui_query
 *
 * Asserts each wrapper is (1) declared as a descriptor consumed by the
 * registerTool/recordToolSchema loops so it is registered + schema-recorded
 * (→ callable via hayba_invoke and surfaced by list_tool_categories), (2) wired
 * to executeCommand with the correct command name, and (3) forwards the exact
 * param names the C++ handler reads (HaybaMCPUIHandler.cpp is the source of
 * truth: ui_add_element→slot_props, ui_query→path).
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(__dirname, '..', 'index.ts'), 'utf-8');

const REGISTRAR_LOOP = /for\s*\(\s*const\s+d\s+of\s+STANDARD_DESCRIPTORS\s*\)\s*registerTool\(/;
const SCHEMA_LOOP = /for\s*\(\s*const\s+d\s+of\s+STANDARD_DESCRIPTORS\s*\)\s*recordToolSchema\(/;
function isToolRegistered(name: string): boolean {
  const descriptor = new RegExp(`name:\\s*['"]${name}['"]`);
  return descriptor.test(indexSrc) && REGISTRAR_LOOP.test(indexSrc);
}
function isSchemaRecorded(name: string): boolean {
  const descriptor = new RegExp(`name:\\s*['"]${name}['"]`);
  return descriptor.test(indexSrc) && SCHEMA_LOOP.test(indexSrc);
}

/** Text of the first content block of a ToolResult. */
function textOf(r: { content: Array<{ type: string; text: string }> }): string {
  return r.content[0].text;
}

describe('UMG / Widget Blueprint wrappers', () => {
  describe('ui_create_widget', () => {
    it('is registered + schema-recorded via the descriptor loops', () => {
      expect(isToolRegistered('ui_create_widget')).toBe(true);
      expect(isSchemaRecorded('ui_create_widget')).toBe(true);
    });

    it('dispatches ui_create_widget with path/name/parent_class', async () => {
      const exec = new InMemoryToolExecutor().on('ui_create_widget', (p) => {
        expect(p).toMatchObject({ path: '/Game/UI', name: 'WBP_Test', parent_class: '/Script/UMG.UserWidget' });
        return { ok: true, data: { path: '/Game/UI/WBP_Test.WBP_Test', name: 'WBP_Test' } };
      });
      setDefaultSender(exec.send);
      const r = await uiCreateWidgetHandler(
        { path: '/Game/UI', name: 'WBP_Test', parent_class: '/Script/UMG.UserWidget' },
        undefined as never,
      );
      expect(r.isError).toBeFalsy();
      expect(textOf(r)).toContain('WBP_Test');
    });

    it('rejects missing required fields', async () => {
      const r = await uiCreateWidgetHandler({ path: '/Game/UI' }, undefined as never);
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/Validation error/);
    });
  });

  describe('ui_add_element', () => {
    it('is registered + schema-recorded via the descriptor loops', () => {
      expect(isToolRegistered('ui_add_element')).toBe(true);
      expect(isSchemaRecorded('ui_add_element')).toBe(true);
    });

    it('forwards slot_props verbatim (matches the C++ param name)', async () => {
      const exec = new InMemoryToolExecutor().on('ui_add_element', (p) => {
        expect(p).toMatchObject({
          widget_blueprint_path: '/Game/UI/WBP_Test',
          child_class: 'TextBlock',
          parent_widget_name: 'Root',
          slot_props: { x: 40, y: 40 },
        });
        return { ok: true, data: { name: 'TextBlock_0', class: 'TextBlock' } };
      });
      setDefaultSender(exec.send);
      const r = await uiAddElementHandler(
        {
          widget_blueprint_path: '/Game/UI/WBP_Test',
          child_class: 'TextBlock',
          parent_widget_name: 'Root',
          slot_props: { x: 40, y: 40 },
        },
        undefined as never,
      );
      expect(r.isError).toBeFalsy();
      expect(textOf(r)).toContain('TextBlock');
    });
  });

  // In deferred routing (the default "hidden until searched" mode) tools are
  // captured, indexed for hayba_search_tools, and bucketed into a domain pack by
  // inferDir. This proves the ui_* tools land in their own loadable 'ui' pack.
  describe('deferred routing / pack discovery', () => {
    it('groups every ui_* tool under the "ui" dir', () => {
      for (const name of UI_TOOLS) {
        expect(inferDir(name), name).toBe('ui');
      }
    });

    it('derives a loadable "ui" domain pack containing all three tools', () => {
      const toolDirs = new Map<string, string | null>(UI_TOOLS.map((n) => [n, inferDir(n)]));
      const packs = deriveDomainPacks(toolDirs, new Map());
      const ui = packs.find((p) => p.name === 'ui');
      expect(ui).toBeDefined();
      expect(ui!.kind).toBe('domain');
      expect(ui!.tools.sort()).toEqual([...UI_TOOLS].sort());
    });
  });

  describe('ui_query', () => {
    it('is registered + schema-recorded via the descriptor loops', () => {
      expect(isToolRegistered('ui_query')).toBe(true);
      expect(isSchemaRecorded('ui_query')).toBe(true);
    });

    it('dispatches ui_query with path (not widget_blueprint_path)', async () => {
      const exec = new InMemoryToolExecutor().on('ui_query', (p) => {
        expect(p).toEqual({ path: '/Game/UI/WBP_Test' });
        return { ok: true, data: { path: '/Game/UI/WBP_Test', root: { class: 'CanvasPanel' } } };
      });
      setDefaultSender(exec.send);
      const r = await uiQueryHandler(
        { path: '/Game/UI/WBP_Test' },
        undefined as never,
      );
      expect(r.isError).toBeFalsy();
      expect(textOf(r)).toContain('CanvasPanel');
    });
  });
});
