/**
 * Issue #339: two independent sessions cold-called a tool with the "obvious"
 * sibling spelling of a param, burned a full validation round-trip, then had
 * to re-read the signature and retry. TOOL_ALIASES is the fix's single
 * source of truth; this file is the acceptance test the issue asked for —
 * it enumerates the map and drives EVERY entry's real handler (not a stand-in)
 * with the alternate spelling, proving the call succeeds exactly as it would
 * with the canonical name.
 *
 * Each tool here is exercised through whichever dispatch path is its real
 * validation gate:
 *   - ueTool-backed tools (ui_query, ui_add_element, asset_delete): the
 *     wrapper handler, via ScriptedUe.
 *   - hand-written handlers (ui_reparent_element, ui_move_element,
 *     python_run): the wrapper handler directly.
 *   - PyToolDescriptor tools (seq_new): makePyToolHandler + a stubbed
 *     python_run sender.
 *   - legacy-only commands (blueprint_create): hayba_invoke's ts→ue_legacy
 *     fallthrough, since that's the only path that ever validates it.
 *   - get_tool_signature: the same normalise-then-delegate call index.ts
 *     performs at its server.tool() registration site (get-tool-signature.ts
 *     itself has no zod schema to alias against — the wire-level widening +
 *     resolveAliases call lives in index.ts, not in a unit-testable module).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { TOOL_ALIASES } from './tool-aliases.js';
import { resolveAliases } from './param-aliases.js';
import { scriptedUe, type ScriptedUe } from './testing/scripted-ue.js';
import { uiQueryHandler } from './ui/ui-query.js';
import { uiAddElementHandler } from './ui/ui-add-element.js';
import { assetDeleteHandler } from './asset/asset-delete.js';
import { uiReparentElementHandler } from './ui/ui-reparent-element.js';
import { uiMoveElementHandler } from './ui/ui-move-element.js';
import { pythonRunHandler } from './python/python-run.js';
import { getToolSignatureHandler } from './code-mode/get-tool-signature.js';
import { invokeHandler } from './routing/meta-tools/invoke.js';
import { makePyToolHandler } from './py-tool-factory.js';
import { seqNewDescriptor } from './sequencer/sequencer-py-tools.js';

let ue: ScriptedUe | undefined;
afterEach(() => {
  ue?.restore();
  ue = undefined;
});

function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content.find((c) => c.type === 'text')?.text ?? '';
}

describe('TOOL_ALIASES enumeration', () => {
  it('covers exactly the tools fixed by issue #339', () => {
    expect(Object.keys(TOOL_ALIASES).sort()).toEqual(
      [
        'asset_delete',
        'blueprint_create',
        'get_tool_signature',
        'python_run',
        'seq_new',
        'ui_add_element',
        'ui_move_element',
        'ui_query',
        'ui_reparent_element',
      ].sort(),
    );
  });

  it('every entry maps at least one canonical name to at least one distinct alternate', () => {
    for (const [tool, aliasMap] of Object.entries(TOOL_ALIASES)) {
      expect(Object.keys(aliasMap).length, tool).toBeGreaterThan(0);
      for (const [canonical, alternates] of Object.entries(aliasMap)) {
        expect(alternates.length, `${tool}.${canonical}`).toBeGreaterThan(0);
        for (const alt of alternates) {
          expect(alt, `${tool}.${canonical}`).not.toBe(canonical);
        }
      }
    }
  });
});

describe('ui_query accepts both spellings', () => {
  it('canonical: path', async () => {
    ue = scriptedUe().replies('ui_query', { path: '/Game/A', parent_class: 'UserWidget', root: {} });
    const r = await uiQueryHandler({ path: '/Game/A' }, {} as never);
    expect(r.isError).toBeFalsy();
    expect(ue.paramsFor('ui_query').path).toBe('/Game/A');
  });

  it('alias: widget_blueprint_path', async () => {
    ue = scriptedUe().replies('ui_query', { path: '/Game/A', parent_class: 'UserWidget', root: {} });
    const r = await uiQueryHandler({ widget_blueprint_path: '/Game/A' }, {} as never);
    expect(r.isError).toBeFalsy();
    expect(ue.paramsFor('ui_query').path).toBe('/Game/A');
  });

  it('rejects conflicting path + widget_blueprint_path', async () => {
    ue = scriptedUe();
    const r = await uiQueryHandler({ path: '/Game/A', widget_blueprint_path: '/Game/B' }, {} as never);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Conflicting values');
    expect(ue.calls).toEqual([]);
  });
});

describe('ui_add_element accepts both spellings', () => {
  it('canonical: child_class / name / parent_widget_name', async () => {
    ue = scriptedUe().replies('ui_add_element', { name: 'Btn' });
    const r = await uiAddElementHandler(
      { widget_blueprint_path: '/Game/A', child_class: 'Button', name: 'Btn', parent_widget_name: 'Root' },
      {} as never,
    );
    expect(r.isError).toBeFalsy();
    const p = ue.paramsFor('ui_add_element');
    expect(p.child_class).toBe('Button');
    expect(p.name).toBe('Btn');
    expect(p.parent_widget_name).toBe('Root');
  });

  it('alias: widget_class / child_name / parent_name', async () => {
    ue = scriptedUe().replies('ui_add_element', { name: 'Btn' });
    const r = await uiAddElementHandler(
      { widget_blueprint_path: '/Game/A', widget_class: 'Button', child_name: 'Btn', parent_name: 'Root' },
      {} as never,
    );
    expect(r.isError).toBeFalsy();
    const p = ue.paramsFor('ui_add_element');
    expect(p.child_class).toBe('Button');
    expect(p.name).toBe('Btn');
    expect(p.parent_widget_name).toBe('Root');
  });

  it('alias: the other alternate for `name` — widget_name', async () => {
    ue = scriptedUe().replies('ui_add_element', { name: 'Btn' });
    const r = await uiAddElementHandler(
      { widget_blueprint_path: '/Game/A', child_class: 'Button', widget_name: 'Btn' },
      {} as never,
    );
    expect(r.isError).toBeFalsy();
    expect(ue.paramsFor('ui_add_element').name).toBe('Btn');
  });
});

describe('asset_delete accepts both spellings', () => {
  it('alias: asset_paths', async () => {
    ue = scriptedUe().replies('asset_delete', { requested: 1, deleted_count: 1, still_on_disk_count: 0, results: [] });
    const r = await assetDeleteHandler({ asset_paths: ['/Game/A'] }, {} as never);
    expect(r.isError).toBeFalsy();
    expect(ue.paramsFor('asset_delete').paths).toEqual(['/Game/A']);
  });
});

describe('ui_reparent_element accepts both spellings', () => {
  it('alias: new_parent_widget_name', async () => {
    ue = scriptedUe().replies('ui_mutate_tree', { ok: true });
    const r = await uiReparentElementHandler(
      { widget_blueprint_path: '/Game/A', widget_name: 'Btn', new_parent_widget_name: 'Panel' },
      {} as never,
    );
    expect(r.isError).toBeFalsy();
    expect(ue.paramsFor('ui_mutate_tree').new_parent_name).toBe('Panel');
  });
});

describe('ui_move_element accepts both spellings', () => {
  it('alias: new_index', async () => {
    ue = scriptedUe().replies('ui_mutate_tree', { ok: true });
    const r = await uiMoveElementHandler(
      { widget_blueprint_path: '/Game/A', widget_name: 'Btn', new_index: 2 },
      {} as never,
    );
    expect(r.isError).toBeFalsy();
    expect(ue.paramsFor('ui_mutate_tree').index).toBe(2);
  });
});

describe('python_run accepts both spellings', () => {
  it('alias: code', async () => {
    ue = scriptedUe().replies('python_run', { stdout: 'hi', stderr: '' });
    const r = await pythonRunHandler({ code: 'print(1)' }, {} as never);
    expect(r.isError).toBeFalsy();
    expect(ue.paramsFor('python_run').script).toBe('print(1)');
  });

  it('rejects conflicting script + code', async () => {
    ue = scriptedUe();
    const r = await pythonRunHandler({ script: 'print(1)', code: 'print(2)' }, {} as never);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Conflicting values');
    expect(ue.calls).toEqual([]);
  });
});

describe('seq_new accepts both spellings', () => {
  it('alias: package_path', async () => {
    const emit = 'HAYBA_JSON:' + JSON.stringify({ ok: true, asset_path: '/Game/Cine/LS', name: 'LS', created: true });
    ue = scriptedUe().replies('python_run', { stdout: emit, stderr: '' });
    const r = await makePyToolHandler(seqNewDescriptor)({ package_path: '/Game/Cine', name: 'LS' });
    expect(r.isError).toBeFalsy();
    expect(ue.paramsFor('python_run').script).toContain("_path = '/Game/Cine'");
  });
});

describe('blueprint_create accepts both spellings (legacy dispatch)', () => {
  it('alias: path / parent_class, folded onto package_path / parent_class_path before hitting the wire', async () => {
    const dispatchLegacy = async (_cmd: string, params: Record<string, unknown>) => params;
    const res = await invokeHandler(
      { name: 'blueprint_create', args: { name: 'BP_Foo', path: '/Game/Foo/BP_Foo', parent_class: '/Script/Engine.Actor' } },
      { dispatch: async () => { throw new Error('should not use the ts route'); }, dispatchLegacy, isDisabled: () => false },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result).toEqual({
        name: 'BP_Foo',
        package_path: '/Game/Foo/BP_Foo',
        parent_class_path: '/Script/Engine.Actor',
      });
    }
  });
});

describe('get_tool_signature accepts both spellings', () => {
  // Mirrors the normalise-then-delegate call index.ts makes at its
  // server.tool('get_tool_signature', ...) registration site.
  it('alias: name (in place of command)', async () => {
    const resolved = resolveAliases({ name: 'ui_query' }, TOOL_ALIASES.get_tool_signature);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const r = await getToolSignatureHandler(resolved.args, {} as never);
    const parsed = JSON.parse(textOf(r)) as { command: string };
    expect(parsed.command).toBe('ui_query');
  });

  it('rejects conflicting command + name', () => {
    const resolved = resolveAliases({ command: 'ui_query', name: 'asset_delete' }, TOOL_ALIASES.get_tool_signature);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toContain('Conflicting values');
  });
});
