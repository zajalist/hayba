import { afterEach, describe, expect, it } from 'vitest';
import { scriptedUe, type ScriptedUe } from '../testing/scripted-ue.js';
import { uiCopyStyleHandler } from './ui-copy-style.js';

let ue: ScriptedUe | undefined;
afterEach(() => {
  ue?.restore();
  ue = undefined;
});

function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content.find((c) => c.type === 'text')?.text ?? '';
}

const BP = '/Game/UI/WBP_Panel';

const workingBorder = {
  name: 'PanelFrame',
  class: 'Border',
  brush_info: {
    draw_as: 'Box',
    resource: '/Game/UI/MI_OrnateFrame_Gold',
    resource_class: 'MaterialInstanceConstant',
    margin: [0.08, 0.08, 0.08, 0.08],
    brush_tint: [1, 1, 1, 1],
    image_size_x: 64,
    image_size_y: 64,
    brush_property: 'Background',
  },
};
const brokenBorder = {
  name: 'ModalFrame',
  class: 'Border',
  brush_info: { draw_as: 'RoundedBox', brush_property: 'Background' },
};

describe('ui_copy_style', () => {
  it('copies the facts that make a frame a frame — draw_as, resource and margin', async () => {
    // These three are exactly what could not be discovered before brush_info
    // reported them, and exactly what made the broken modal broken.
    ue = scriptedUe()
      .replies('ui_layout_snapshot', { layout_resolved: true, widgets: [workingBorder, brokenBorder] })
      .replies('ui_set_brush', { ok: true });

    await uiCopyStyleHandler(
      { widget_blueprint_path: BP, from_widget: 'PanelFrame', to_widget: 'ModalFrame', include: ['brush'] },
      {} as never,
    );

    expect(ue.paramsFor('ui_set_brush')).toMatchObject({
      widget_name: 'ModalFrame',
      draw_as: 'Box',
      resource: '/Game/UI/MI_OrnateFrame_Gold',
      margin: [0.08, 0.08, 0.08, 0.08],
    });
  });

  it("writes to the TARGET's brush property, not the source's", async () => {
    // Copying a Border's style onto an Image must write Brush, not Background,
    // or the call reports success and changes nothing.
    const targetImage = { name: 'Icon', class: 'Image', brush_info: { draw_as: 'Image', brush_property: 'Brush' } };
    ue = scriptedUe()
      .replies('ui_layout_snapshot', { layout_resolved: true, widgets: [workingBorder, targetImage] })
      .replies('ui_set_brush', { ok: true });

    await uiCopyStyleHandler(
      { widget_blueprint_path: BP, from_widget: 'PanelFrame', to_widget: 'Icon', include: ['brush'] },
      {} as never,
    );
    expect(ue.paramsFor('ui_set_brush').brush_property).toBe('Brush');
  });

  it('copies font and typeface together', async () => {
    const src = { name: 'GoodLabel', class: 'TextBlock', text_info: { font_object: '/Game/F_Body', typeface: 'Italic', size: 18 } };
    const dst = { name: 'BadLabel', class: 'TextBlock', text_info: { font_object: '/Engine/EngineFonts/Roboto', typeface: 'Bold' } };
    ue = scriptedUe()
      .replies('ui_layout_snapshot', { layout_resolved: true, widgets: [src, dst] })
      .replies('ui_set_text_style', { ok: true });

    await uiCopyStyleHandler(
      { widget_blueprint_path: BP, from_widget: 'GoodLabel', to_widget: 'BadLabel', include: ['text'] },
      {} as never,
    );
    expect(ue.paramsFor('ui_set_text_style')).toMatchObject({
      font_asset: '/Game/F_Body',
      typeface: 'Italic',
      size: 18,
    });
  });

  it('never copies slot layout or text content', async () => {
    const src = {
      name: 'GoodLabel',
      class: 'TextBlock',
      text_info: { font_object: '/Game/F_Body', typeface: 'Regular' },
      x: 10,
      y: 20,
      width: 100,
    };
    ue = scriptedUe()
      .replies('ui_layout_snapshot', { layout_resolved: true, widgets: [src, { name: 'B', class: 'TextBlock', text_info: {} }] })
      .replies('ui_set_text_style', { ok: true });

    await uiCopyStyleHandler({ widget_blueprint_path: BP, from_widget: 'GoodLabel', to_widget: 'B' }, {} as never);
    const sent = ue.paramsFor('ui_set_text_style');
    // Matching a look must not move the target or overwrite what it says.
    expect(sent).not.toHaveProperty('text');
    expect(sent).not.toHaveProperty('x');
    expect(sent).not.toHaveProperty('width');
  });

  it('writes nothing on a dry run', async () => {
    ue = scriptedUe().replies('ui_layout_snapshot', { layout_resolved: true, widgets: [workingBorder, brokenBorder] });
    const r = await uiCopyStyleHandler(
      { widget_blueprint_path: BP, from_widget: 'PanelFrame', to_widget: 'ModalFrame', dry_run: true },
      {} as never,
    );
    expect(JSON.parse(textOf(r)).dry_run).toBe(true);
    expect(ue.calls.some((c) => c.cmd.startsWith('ui_set_'))).toBe(false);
  });

  it('errors clearly when a named widget does not exist', async () => {
    ue = scriptedUe().replies('ui_layout_snapshot', { layout_resolved: true, widgets: [workingBorder] });
    const r = await uiCopyStyleHandler(
      { widget_blueprint_path: BP, from_widget: 'PanelFrame', to_widget: 'Nope' },
      {} as never,
    );
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('"Nope" not found');
  });

  it('reports honestly when the source has no style to copy', async () => {
    ue = scriptedUe().replies('ui_layout_snapshot', {
      layout_resolved: true,
      widgets: [{ name: 'Empty', class: 'SizeBox' }, { name: 'Target', class: 'Border' }],
    });
    const r = await uiCopyStyleHandler(
      { widget_blueprint_path: BP, from_widget: 'Empty', to_widget: 'Target' },
      {} as never,
    );
    const body = JSON.parse(textOf(r)) as { copied_count: number; note: string };
    expect(body.copied_count).toBe(0);
    expect(body.note).toContain('Nothing was written');
    expect(ue.calls.some((c) => c.cmd.startsWith('ui_set_'))).toBe(false);
  });
});
