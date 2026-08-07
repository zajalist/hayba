import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryToolExecutor, setDefaultSender } from '../tool-executor.js';

import { uiSearchWidgetsHandler } from './ui-search-widgets.js';
import { uiSetSlotLayoutHandler } from './ui-set-slot-layout.js';
import { uiSetWidgetPropertiesHandler } from './ui-set-widget-properties.js';
import { uiSetBrushHandler } from './ui-set-brush.js';
import { uiSetTextStyleHandler } from './ui-set-text-style.js';
import { uiBuildTreeHandler } from './ui-build-tree.js';
import { uiDuplicateElementHandler } from './ui-duplicate-element.js';
import { uiMoveElementHandler } from './ui-move-element.js';
import { uiRenameElementHandler } from './ui-rename-element.js';
import { uiSetVariableHandler } from './ui-set-variable.js';
import { uiListWidgetBlueprintsHandler } from './ui-list-widget-blueprints.js';
import { uiMeasureTextHandler } from './ui-measure-text.js';
import { uiLayoutSnapshotHandler } from './ui-layout-snapshot.js';

// Regression tests for wrapper→handler dispatch.
//
// Every case here corresponds to a payload that the C++ handler did not read,
// which meant the tool reported nothing useful (or failed outright) while
// looking perfectly well-formed from the caller's side. The assertions pin the
// exact param names HaybaMCPUIHandler.cpp reads.

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(__dirname, '..', 'index.ts'), 'utf-8');

function textOf(r: { content: Array<{ type: string; text: string }> }): string {
  return r.content[0]!.text;
}

const ok = (data: Record<string, unknown>) => ({ ok: true, data });

describe('ui_search_widgets', () => {
  it('sends `path` and the handler-side filter names', async () => {
    // It used to forward its own field names, so no `path` reached the handler
    // and every single call failed with "ui_query: missing path".
    let seen: Record<string, unknown> | null = null;
    const exec = new InMemoryToolExecutor().on('ui_query', (p) => {
      seen = p;
      return ok({ matches: [], match_count: 0 });
    });
    setDefaultSender(exec.send);

    const r = await uiSearchWidgetsHandler(
      { widget_blueprint_path: '/Game/UI/WBP_Test', widget_name_pattern: 'Btn', widget_class: 'Button' },
      undefined as never,
    );

    expect(r.isError).toBeFalsy();
    expect(seen).toMatchObject({
      path: '/Game/UI/WBP_Test',
      name_pattern: 'Btn',
      class_filter: 'Button',
      flatten: true,
    });
    expect(seen).not.toHaveProperty('widget_blueprint_path');
  });
});

describe('ui_set_slot_layout', () => {
  it('sends slot_props, not the slot_layout shape no handler ever read', async () => {
    let seen: Record<string, unknown> | null = null;
    const exec = new InMemoryToolExecutor().on('ui_set_widget_properties', (p) => {
      seen = p;
      return ok({ succeeded: 3, failed: 0 });
    });
    setDefaultSender(exec.send);

    const r = await uiSetSlotLayoutHandler(
      {
        widget_blueprint_path: '/Game/UI/WBP_Test',
        widget_name: 'Title',
        anchors_min: [0.5, 0],
        position: [0, 40],
        z_order: 3,
      },
      undefined as never,
    );

    expect(r.isError).toBeFalsy();
    expect(seen).toHaveProperty('slot_props');
    expect(seen).not.toHaveProperty('slot_layout');
    expect((seen as unknown as { slot_props: Record<string, unknown> }).slot_props).toEqual({
      anchors_min: [0.5, 0],
      position: [0, 40],
      z_order: 3,
    });
  });

  it('omits fields the caller did not set rather than sending undefined', async () => {
    let seen: Record<string, unknown> | null = null;
    const exec = new InMemoryToolExecutor().on('ui_set_widget_properties', (p) => {
      seen = p;
      return ok({ succeeded: 1, failed: 0 });
    });
    setDefaultSender(exec.send);

    await uiSetSlotLayoutHandler(
      { widget_blueprint_path: '/Game/UI/WBP_Test', widget_name: 'Title', padding: 0 },
      undefined as never,
    );

    // Zero padding must survive: it is how a caller clears a margin.
    expect((seen as unknown as { slot_props: Record<string, unknown> }).slot_props).toEqual({ padding: 0 });
  });

  it('refuses a call with no layout fields instead of round-tripping a no-op', async () => {
    const r = await uiSetSlotLayoutHandler(
      { widget_blueprint_path: '/Game/UI/WBP_Test', widget_name: 'Title' },
      undefined as never,
    );
    expect(r.isError).toBe(true);
  });

  it('accepts the natural `anchors` spelling as a 4-array', async () => {
    // Before this, zod's default strip mode silently DELETED `anchors`, the
    // remaining fields applied, and the tool reported success — the field
    // conclusion was "anchors are a silent no-op".
    let seen: Record<string, unknown> | null = null;
    const exec = new InMemoryToolExecutor().on('ui_set_widget_properties', (p) => {
      seen = p;
      return ok({ succeeded: 2, failed: 0 });
    });
    setDefaultSender(exec.send);

    const r = await uiSetSlotLayoutHandler(
      { widget_blueprint_path: '/Game/UI/WBP_Test', widget_name: 'Title', anchors: [0, 0, 1, 1] },
      undefined as never,
    );
    expect(r.isError).toBeFalsy();
    expect((seen as unknown as { slot_props: Record<string, unknown> }).slot_props).toEqual({
      anchors_min: [0, 0],
      anchors_max: [1, 1],
    });
  });

  it('accepts `anchors` as {min, max} pairs', async () => {
    let seen: Record<string, unknown> | null = null;
    const exec = new InMemoryToolExecutor().on('ui_set_widget_properties', (p) => {
      seen = p;
      return ok({ succeeded: 2, failed: 0 });
    });
    setDefaultSender(exec.send);

    await uiSetSlotLayoutHandler(
      {
        widget_blueprint_path: '/Game/UI/WBP_Test',
        widget_name: 'Title',
        anchors: { min: [0.5, 0], max: [0.5, 0] },
        position: [0, 40],
      },
      undefined as never,
    );
    expect((seen as unknown as { slot_props: Record<string, unknown> }).slot_props).toEqual({
      anchors_min: [0.5, 0],
      anchors_max: [0.5, 0],
      position: [0, 40],
    });
  });

  it('rejects unknown parameter names loudly instead of stripping them', async () => {
    // The silent-strip failure mode: an invented key used to vanish before the
    // wire while everything else applied and the call reported success.
    const r = await uiSetSlotLayoutHandler(
      { widget_blueprint_path: '/Game/UI/WBP_Test', widget_name: 'Title', anchor: [0, 0, 1, 1] },
      undefined as never,
    );
    expect(r.isError).toBe(true);
    expect(textOf(r as { content: Array<{ type: string; text: string }> })).toMatch(/anchor/);
  });
});

describe('ui_set_widget_properties', () => {
  it('accepts nested struct values', async () => {
    // The schema used to reject nested objects, so no caller could set a Brush
    // or a Font through the generic tool at all.
    let seen: Record<string, unknown> | null = null;
    const exec = new InMemoryToolExecutor().on('ui_set_widget_properties', (p) => {
      seen = p;
      return ok({ succeeded: 1, failed: 0 });
    });
    setDefaultSender(exec.send);

    const r = await uiSetWidgetPropertiesHandler(
      {
        widget_blueprint_path: '/Game/UI/WBP_Test',
        widget_name: 'Title',
        properties: { Font: { Size: 32, TypefaceFontName: 'Bold' } },
      },
      undefined as never,
    );

    expect(r.isError).toBeFalsy();
    expect(seen).toMatchObject({ properties: { Font: { Size: 32, TypefaceFontName: 'Bold' } } });
  });

  it('rejects a call with neither properties nor slot_props', async () => {
    const r = await uiSetWidgetPropertiesHandler(
      { widget_blueprint_path: '/Game/UI/WBP_Test', widget_name: 'Title' },
      undefined as never,
    );
    expect(r.isError).toBe(true);
  });
});

describe('ui_set_brush', () => {
  it('sends the resource as a bare asset path', async () => {
    let seen: Record<string, unknown> | null = null;
    const exec = new InMemoryToolExecutor().on('ui_set_widget_properties', (p) => {
      seen = p;
      return ok({ succeeded: 1, failed: 0 });
    });
    setDefaultSender(exec.send);

    await uiSetBrushHandler(
      { widget_blueprint_path: '/Game/UI/WBP_Test', widget_name: 'Bg', resource: '/Game/UI/T_Panel', tint: [1, 1, 1, 1] },
      undefined as never,
    );

    const props = (seen as unknown as { properties: { Brush: Record<string, unknown> } }).properties;
    expect(props.Brush.ResourceObject).toBe('/Game/UI/T_Panel');
  });

  it('writes Background rather than Brush when targeting a Border', async () => {
    let seen: Record<string, unknown> | null = null;
    const exec = new InMemoryToolExecutor().on('ui_set_widget_properties', (p) => {
      seen = p;
      return ok({ succeeded: 1, failed: 0 });
    });
    setDefaultSender(exec.send);

    await uiSetBrushHandler(
      {
        widget_blueprint_path: '/Game/UI/WBP_Test',
        widget_name: 'Card',
        tint: [0, 0, 0, 0.5],
        brush_property: 'Background',
      },
      undefined as never,
    );

    const props = (seen as unknown as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty('Background');
    expect(props).not.toHaveProperty('Brush');
  });
});

describe('ui_set_text_style', () => {
  it('uses the real FSlateFontInfo field names', async () => {
    let seen: Record<string, unknown> | null = null;
    const exec = new InMemoryToolExecutor().on('ui_set_widget_properties', (p) => {
      seen = p;
      return ok({ succeeded: 1, failed: 0 });
    });
    setDefaultSender(exec.send);

    await uiSetTextStyleHandler(
      {
        widget_blueprint_path: '/Game/UI/WBP_Test',
        widget_name: 'Title',
        font_asset: '/Game/UI/Fonts/Cormorant',
        typeface: 'Bold',
        size: 48,
      },
      undefined as never,
    );

    const font = (seen as unknown as { properties: { Font: Record<string, unknown> } }).properties.Font;
    // `Typeface: {FontName}` matched no property on the struct; the field is
    // TypefaceFontName and FontObject takes an asset path.
    expect(font).toEqual({ FontObject: '/Game/UI/Fonts/Cormorant', Size: 48, TypefaceFontName: 'Bold' });
  });
});

describe('tree mutation wrappers map onto ui_mutate_tree operations', () => {
  const cases: Array<[string, (a: Record<string, unknown>) => Promise<{ isError?: boolean }>, Record<string, unknown>]> = [
    ['duplicate', (a) => uiDuplicateElementHandler(a, undefined as never), { widget_name: 'Row' }],
    ['move', (a) => uiMoveElementHandler(a, undefined as never), { widget_name: 'Row', index: 2 }],
    ['rename', (a) => uiRenameElementHandler(a, undefined as never), { widget_name: 'Row', new_name: 'FirstRow' }],
  ];

  for (const [operation, run, args] of cases) {
    it(`ui_${operation === 'move' ? 'move_element' : operation}s via operation:"${operation}"`, async () => {
      let seen: Record<string, unknown> | null = null;
      const exec = new InMemoryToolExecutor().on('ui_mutate_tree', (p) => {
        seen = p;
        return ok({ operation });
      });
      setDefaultSender(exec.send);

      const r = await run({ widget_blueprint_path: '/Game/UI/WBP_Test', ...args });
      expect(r.isError).toBeFalsy();
      expect(seen).toMatchObject({ operation, widget_blueprint_path: '/Game/UI/WBP_Test', ...args });
    });
  }
});

describe('new commands dispatch to their own handler names', () => {
  it('ui_build_tree forwards the nested spec unchanged', async () => {
    let seen: Record<string, unknown> | null = null;
    const exec = new InMemoryToolExecutor().on('ui_build_tree', (p) => {
      seen = p;
      return ok({ created: 2, names: ['Col', 'Title'] });
    });
    setDefaultSender(exec.send);

    const tree = {
      class: 'VerticalBox',
      name: 'Col',
      children: [{ class: 'TextBlock', name: 'Title', properties: { Text: 'Hi' } }],
    };
    const r = await uiBuildTreeHandler({ widget_blueprint_path: '/Game/UI/WBP_Test', tree }, undefined as never);

    expect(r.isError).toBeFalsy();
    expect(seen).toMatchObject({ tree });
  });

  it('ui_build_tree rejects a node with no class', async () => {
    const r = await uiBuildTreeHandler(
      { widget_blueprint_path: '/Game/UI/WBP_Test', tree: { name: 'Col' } },
      undefined as never,
    );
    expect(r.isError).toBe(true);
  });

  it('ui_set_variable defaults is_variable to true', async () => {
    let seen: Record<string, unknown> | null = null;
    const exec = new InMemoryToolExecutor().on('ui_set_variable', (p) => {
      seen = p;
      return ok({ is_variable: true });
    });
    setDefaultSender(exec.send);

    await uiSetVariableHandler(
      { widget_blueprint_path: '/Game/UI/WBP_Test', widget_name: 'Title' },
      undefined as never,
    );
    expect(seen).toMatchObject({ is_variable: true });
  });

  it('ui_list_widget_blueprints dispatches with no required args', async () => {
    const exec = new InMemoryToolExecutor().on('ui_list_widget_blueprints', () => ok({ widget_blueprints: [], count: 0 }));
    setDefaultSender(exec.send);
    const r = await uiListWidgetBlueprintsHandler({}, undefined as never);
    expect(r.isError).toBeFalsy();
  });

  it('ui_layout_snapshot dispatches with the blueprint path', async () => {
    const exec = new InMemoryToolExecutor().on('ui_layout_snapshot', (p) => {
      expect(p).toMatchObject({ widget_blueprint_path: '/Game/UI/WBP_Test' });
      return ok({ layout_resolved: true, widgets: [] });
    });
    setDefaultSender(exec.send);
    const r = await uiLayoutSnapshotHandler({ widget_blueprint_path: '/Game/UI/WBP_Test' }, undefined as never);
    expect(r.isError).toBeFalsy();
  });
});

describe('ui_measure_text', () => {
  it('measures against a widget font when a widget is given', async () => {
    const exec = new InMemoryToolExecutor().on('ui_measure_text', (p) => {
      expect(p).toMatchObject({ widget_blueprint_path: '/Game/UI/WBP_Test', widget_name: 'Title', text: 'Hello' });
      return ok({ width_px: 80, chars_that_fit: 5 });
    });
    setDefaultSender(exec.send);
    const r = await uiMeasureTextHandler(
      { text: 'Hello', widget_blueprint_path: '/Game/UI/WBP_Test', widget_name: 'Title' },
      undefined as never,
    );
    expect(r.isError).toBeFalsy();
  });

  it('refuses a call with neither a widget nor a font size', async () => {
    // Without one of the two there is nothing to measure with, and guessing a
    // font would produce a precise, wrong answer.
    const r = await uiMeasureTextHandler({ text: 'Hello' }, undefined as never);
    expect(r.isError).toBe(true);
    expect(textOf(r as { content: Array<{ type: string; text: string }> })).toMatch(/font_size/);
  });
});

// The duplicate path is C++, so what is pinned here is the invariant it depends
// on. A live editor showed the original bug: duplicating "Card" renamed the
// ORIGINAL's children out from under the blueprint, because a UPanelSlot's
// Content is a plain pointer rather than a subobject — DuplicateObject copies
// the pointer, so the "copy" shares the source's children.
//
// Two earlier fixes treated the symptom by renaming after the fact and did not
// work. The tree is now rebuilt node by node instead.
describe('ui_duplicate_element deep clone (C++ invariant)', () => {
  const handlerSrc = readFileSync(
    join(
      __dirname,
      '..', '..', '..', '..', '..',
      'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private', 'handlers', 'HaybaMCPUIHandler.cpp',
    ),
    'utf-8',
  );

  it('rebuilds the subtree rather than calling DuplicateObject on it', () => {
    expect(handlerSrc).toContain('DeepCloneWidget');
    // The clone must construct genuinely new widgets, not duplicate the source.
    expect(handlerSrc).toMatch(/DeepCloneWidget[\s\S]{0,1500}ConstructWidget<UWidget>/);
  });

  it('never copies a panel Slots array between widgets', () => {
    // Copying Slots is what makes two widgets claim the same children.
    expect(handlerSrc).toMatch(/PropName == TEXT\("Slots"\)\) continue/);
  });

  it('never copies a slot Content or Parent pointer between slots', () => {
    // Copying Content made the new slot adopt the SOURCE's child, so the tree
    // held one widget reached through two slots — two entries with the same
    // name AND the same object path. Layout values are the only thing worth
    // copying between slots.
    expect(handlerSrc).toMatch(/PropName == TEXT\("Content"\)\) continue/);
    expect(handlerSrc).toMatch(/PropName == TEXT\("Parent"\)\) continue/);
  });

  it('keeps the structural notification, like every other tree mutation', () => {
    // A stage trace made the recompile look guilty: the copy was fine before
    // MarkBlueprintAsStructurallyModified and TRASH_ after. It was innocent.
    // The copy was ORPHANED — its parent slot pointed at the source's child —
    // so the recompile collected a widget nothing referenced. Deferring the
    // compile was tried and reverted once the slot pointers were fixed, because
    // it treated the symptom and diverged from every other operation here.
    const dup = handlerSrc.slice(
      handlerSrc.indexOf('Operation == TEXT("duplicate")'),
      handlerSrc.indexOf('Operation == TEXT("replace")'),
    );
    expect(dup).toContain('MarkBlueprintAsStructurallyModified');
  });

  it('verifies its own post-condition rather than trusting the operation', () => {
    expect(handlerSrc).toMatch(/widgets now share the name/);
    expect(handlerSrc).toMatch(/did not come out clean/);
  });
});

describe('descriptor registration', () => {
  const NEW_TOOLS = [
    'ui_build_tree',
    'ui_duplicate_element',
    'ui_move_element',
    'ui_rename_element',
    'ui_set_variable',
    'ui_list_widget_blueprints',
    'ui_layout_snapshot',
    'ui_measure_text',
    'ui_validate',
  ];

  for (const name of NEW_TOOLS) {
    it(`${name} has a descriptor entry`, () => {
      expect(new RegExp(`name:\\s*['"]${name}['"]`).test(indexSrc)).toBe(true);
    });
  }
});
