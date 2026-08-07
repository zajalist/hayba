import { afterEach, describe, expect, it } from 'vitest';
import { scriptedUe, type ScriptedUe } from '../testing/scripted-ue.js';
import { uiSetDefaultFontHandler } from './ui-set-default-font.js';

let ue: ScriptedUe | undefined;
afterEach(() => {
  ue?.restore();
  ue = undefined;
});

function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content.find((c) => c.type === 'text')?.text ?? '';
}

const BP = '/Game/UI/WBP_Panel';
const PROJECT_FONT = '/Game/UI/Fonts/F_Body';

function snapshot(widgets: unknown[], extra: Record<string, unknown> = {}) {
  return { layout_resolved: true, widgets, ...extra };
}

const engineText = (name: string) => ({
  name,
  class: 'TextBlock',
  text_info: { font_object: '/Engine/EngineFonts/Roboto', typeface: 'Bold' },
});
const projectText = (name: string) => ({
  name,
  class: 'TextBlock',
  text_info: { font_object: PROJECT_FONT, typeface: 'Regular' },
});

describe('ui_set_default_font', () => {
  it('rewrites only the widgets still on an engine font', async () => {
    ue = scriptedUe()
      .replies('ui_layout_snapshot', snapshot([engineText('Title'), projectText('Body'), engineText('Label')]))
      .replies('ui_set_widget_properties', { succeeded: 1, failed: 0 });

    const r = await uiSetDefaultFontHandler(
      { widget_blueprint_path: BP, font_asset: PROJECT_FONT },
      {} as never,
    );
    const body = JSON.parse(textOf(r)) as { changed_count: number; changed: Array<{ widget: string }> };
    expect(body.changed_count).toBe(2);
    expect(body.changed.map((c) => c.widget)).toEqual(['Title', 'Label']);
    // Body was already on the project font and must not be touched. The wire
    // command is ui_set_widget_properties — 'ui_set_text_style' is a TS tool
    // name the plugin does not know (the old re-dispatch bug).
    expect(ue.calls.filter((c) => c.cmd === 'ui_set_widget_properties')).toHaveLength(2);
    expect(ue.calls.some((c) => c.cmd === 'ui_set_text_style')).toBe(false);
  });

  it('always sends font_asset AND typeface together', async () => {
    // Sending one without the other is the exact mistake this tool undoes:
    // ui_set_text_style only changes what it is given, so a font without a
    // typeface leaves Roboto Bold in place and still reports success.
    ue = scriptedUe()
      .replies('ui_layout_snapshot', snapshot([engineText('Title')]))
      .replies('ui_set_widget_properties', { succeeded: 1, failed: 0 });

    await uiSetDefaultFontHandler({ widget_blueprint_path: BP, font_asset: PROJECT_FONT }, {} as never);
    expect(ue.paramsFor('ui_set_widget_properties')).toMatchObject({
      widget_name: 'Title',
      properties: { Font: { FontObject: PROJECT_FONT, TypefaceFontName: 'Regular' } },
    });
  });

  it('defaults the typeface to Regular, not the engine default Bold', async () => {
    ue = scriptedUe()
      .replies('ui_layout_snapshot', snapshot([engineText('Title')]))
      .replies('ui_set_widget_properties', { succeeded: 1, failed: 0 });
    await uiSetDefaultFontHandler({ widget_blueprint_path: BP, font_asset: PROJECT_FONT }, {} as never);
    const font = (ue.paramsFor('ui_set_widget_properties').properties as { Font: Record<string, unknown> }).Font;
    expect(font.TypefaceFontName).toBe('Regular');
  });

  it('touches every text widget when only_engine_fonts is false', async () => {
    ue = scriptedUe()
      .replies('ui_layout_snapshot', snapshot([engineText('Title'), projectText('Body')]))
      .replies('ui_set_widget_properties', { succeeded: 1, failed: 0 });
    const r = await uiSetDefaultFontHandler(
      { widget_blueprint_path: BP, font_asset: PROJECT_FONT, only_engine_fonts: false },
      {} as never,
    );
    expect((JSON.parse(textOf(r)) as { changed_count: number }).changed_count).toBe(2);
  });

  it('writes nothing on a dry run', async () => {
    ue = scriptedUe().replies('ui_layout_snapshot', snapshot([engineText('Title')]));
    const r = await uiSetDefaultFontHandler(
      { widget_blueprint_path: BP, font_asset: PROJECT_FONT, dry_run: true },
      {} as never,
    );
    const body = JSON.parse(textOf(r)) as { would_change_count: number };
    expect(body.would_change_count).toBe(1);
    expect(ue.calls.some((c) => c.cmd === 'ui_set_widget_properties')).toBe(false);
  });

  it('does NOT report an unlaid-out blueprint as a clean sweep', async () => {
    // A blueprint that failed to instantiate yields zero text widgets, which
    // would otherwise read identically to "nothing needed changing" — the
    // silent-success shape this codebase keeps getting bitten by.
    ue = scriptedUe().replies('ui_layout_snapshot', {
      layout_resolved: false,
      layout_error: 'needs compiling',
      widgets: [],
    });
    const r = await uiSetDefaultFontHandler(
      { widget_blueprint_path: BP, font_asset: PROJECT_FONT },
      {} as never,
    );
    const body = JSON.parse(textOf(r)) as { note: string };
    expect(body.note).toContain('NOT a clean result');
    expect(body.note).toContain('needs compiling');
  });

  it('says plainly when nothing is on an engine font', async () => {
    ue = scriptedUe().replies('ui_layout_snapshot', snapshot([projectText('Body')]));
    const r = await uiSetDefaultFontHandler(
      { widget_blueprint_path: BP, font_asset: PROJECT_FONT },
      {} as never,
    );
    const body = JSON.parse(textOf(r)) as { note: string; text_widgets_examined: number };
    expect(body.note).toContain('Nothing to do');
    // Reporting how many were actually looked at is what separates this from
    // the unlaid-out case above.
    expect(body.text_widgets_examined).toBe(1);
  });

  it('reports per-widget failures instead of aborting the sweep', async () => {
    ue = scriptedUe().replies('ui_layout_snapshot', snapshot([engineText('A'), engineText('B')]));
    let call = 0;
    (ue as unknown as { exec: { on: (c: string, f: () => unknown) => void } }).exec.on('ui_set_widget_properties', () => {
      call++;
      return call === 1 ? { ok: false, error: 'widget is read-only' } : { ok: true, data: { ok: true } };
    });
    const r = await uiSetDefaultFontHandler(
      { widget_blueprint_path: BP, font_asset: PROJECT_FONT },
      {} as never,
    );
    const body = JSON.parse(textOf(r)) as { changed_count: number; failed_count: number };
    expect(body.failed_count).toBe(1);
    expect(body.changed_count).toBe(1);
  });
});
