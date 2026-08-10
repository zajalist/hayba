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
      .replies('ui_set_widget_properties', { succeeded: 1, failed: 0 });

    await uiCopyStyleHandler(
      { widget_blueprint_path: BP, from_widget: 'PanelFrame', to_widget: 'ModalFrame', include: ['brush'] },
      {} as never,
    );

    expect(ue.paramsFor('ui_set_widget_properties')).toMatchObject({
      widget_name: 'ModalFrame',
      properties: {
        Background: {
          DrawAs: 'Box',
          ResourceObject: '/Game/UI/MI_OrnateFrame_Gold',
          Margin: { Left: 0.08, Top: 0.08, Right: 0.08, Bottom: 0.08 },
        },
      },
    });
  });

  it('targets exact widget names so a large tree cannot truncate away a newly added target', async () => {
    ue = scriptedUe()
      .replies('ui_layout_snapshot', (params) => {
        expect(params.widget_names).toEqual(['PanelFrame', 'ModalFrame']);
        return { layout_resolved: true, widgets: [workingBorder, brokenBorder] };
      })
      .replies('ui_set_widget_properties', { succeeded: 1, failed: 0 });

    const r = await uiCopyStyleHandler(
      { widget_blueprint_path: BP, from_widget: 'PanelFrame', to_widget: 'ModalFrame', include: ['brush'] },
      {} as never,
    );
    expect(r.isError).toBeFalsy();
  });

  it('reaches UE only through commands the plugin actually registers', async () => {
    // Regression: this tool used to re-dispatch "ui_set_brush" /
    // "ui_set_text_style" over the socket. Those are TS-layer tool names, not
    // UE commands, so the plugin answered "Unknown command: ui_set_brush" —
    // while the top-level tools of the same name worked, because they translate
    // onto ui_set_widget_properties first.
    ue = scriptedUe()
      .replies('ui_layout_snapshot', { layout_resolved: true, widgets: [workingBorder, brokenBorder] })
      .replies('ui_set_widget_properties', { succeeded: 1, failed: 0 });

    const r = await uiCopyStyleHandler(
      { widget_blueprint_path: BP, from_widget: 'PanelFrame', to_widget: 'ModalFrame', include: ['brush'] },
      {} as never,
    );

    expect(r.isError).toBeFalsy();
    const wireCommands = ue.calls.map((c) => c.cmd);
    expect(wireCommands).not.toContain('ui_set_brush');
    expect(wireCommands).not.toContain('ui_set_text_style');
    expect(wireCommands).toContain('ui_set_widget_properties');
  });

  it("writes to the TARGET's brush property, not the source's", async () => {
    // Copying a Border's style onto an Image must write Brush, not Background,
    // or the call reports success and changes nothing.
    const targetImage = { name: 'Icon', class: 'Image', brush_info: { draw_as: 'Image', brush_property: 'Brush' } };
    ue = scriptedUe()
      .replies('ui_layout_snapshot', { layout_resolved: true, widgets: [workingBorder, targetImage] })
      .replies('ui_set_widget_properties', { succeeded: 1, failed: 0 });

    await uiCopyStyleHandler(
      { widget_blueprint_path: BP, from_widget: 'PanelFrame', to_widget: 'Icon', include: ['brush'] },
      {} as never,
    );
    const props = ue.paramsFor('ui_set_widget_properties').properties as Record<string, unknown>;
    expect(props).toHaveProperty('Brush');
    expect(props).not.toHaveProperty('Background');
  });

  it('copies font and typeface together', async () => {
    const src = { name: 'GoodLabel', class: 'TextBlock', text_info: { font_object: '/Game/F_Body', typeface: 'Italic', size: 18 } };
    const dst = { name: 'BadLabel', class: 'TextBlock', text_info: { font_object: '/Engine/EngineFonts/Roboto', typeface: 'Bold' } };
    ue = scriptedUe()
      .replies('ui_layout_snapshot', { layout_resolved: true, widgets: [src, dst] })
      .replies('ui_set_widget_properties', { succeeded: 1, failed: 0 });

    await uiCopyStyleHandler(
      { widget_blueprint_path: BP, from_widget: 'GoodLabel', to_widget: 'BadLabel', include: ['text'] },
      {} as never,
    );
    expect(ue.paramsFor('ui_set_widget_properties')).toMatchObject({
      properties: {
        Font: { FontObject: '/Game/F_Body', TypefaceFontName: 'Italic', Size: 18 },
      },
    });
  });

  // The field the layout snapshot ACTUALLY emits is `font_size`; this reader
  // looked for `size`, so a real copy transferred font, typeface and colour and
  // silently left the size behind. A 26pt source left the target at 24pt, which
  // inflated a row from 40px to 57px and was only caught by a layout snapshot.
  //
  // The test above passes `size`, which is why it stayed green through all of
  // that: it asserted the author's model of the payload rather than the payload
  // the C++ sends. Both spellings are pinned now.
  it('copies the size the snapshot really reports (font_size)', async () => {
    const src = { name: 'GoodLabel', class: 'TextBlock', text_info: { font_object: '/Game/F_Body', typeface: 'Regular', font_size: 26 } };
    const dst = { name: 'BadLabel', class: 'TextBlock', text_info: { font_object: '/Game/F_Body', typeface: 'Regular', font_size: 24 } };
    ue = scriptedUe()
      .replies('ui_layout_snapshot', { layout_resolved: true, widgets: [src, dst] })
      .replies('ui_set_widget_properties', { succeeded: 1, failed: 0 });

    await uiCopyStyleHandler(
      { widget_blueprint_path: BP, from_widget: 'GoodLabel', to_widget: 'BadLabel', include: ['text'] },
      {} as never,
    );
    const props = ue.paramsFor('ui_set_widget_properties').properties as { Font: { Size?: number } };
    expect(props.Font.Size, 'the source was 26pt; copying text style must carry the size').toBe(26);
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
      .replies('ui_set_widget_properties', { succeeded: 1, failed: 0 });

    await uiCopyStyleHandler({ widget_blueprint_path: BP, from_widget: 'GoodLabel', to_widget: 'B' }, {} as never);
    const sent = ue.paramsFor('ui_set_widget_properties');
    const props = sent.properties as Record<string, unknown>;
    // Matching a look must not move the target or overwrite what it says.
    expect(props).not.toHaveProperty('Text');
    expect(sent).not.toHaveProperty('slot_props');
    expect(props).not.toHaveProperty('x');
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
