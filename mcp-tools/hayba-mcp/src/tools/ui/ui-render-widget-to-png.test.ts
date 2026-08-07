import { afterEach, describe, expect, it } from 'vitest';
import { scriptedUe, type ScriptedUe } from '../testing/scripted-ue.js';
import { uiRenderWidgetToPngHandler } from './ui-render-widget-to-png.js';

let ue: ScriptedUe | undefined;
afterEach(() => {
  ue?.restore();
  ue = undefined;
});

const BP = '/Game/UI/WBP_Panel';
// 1x1 transparent PNG.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function blocks(r: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }) {
  return {
    image: r.content.find((c) => c.type === 'image'),
    text: r.content.find((c) => c.type === 'text')?.text ?? '',
  };
}

describe('ui_render_widget_to_png', () => {
  it('returns the PNG as an image block, not buried in the text', async () => {
    // The whole point of the tool is that the caller can SEE the widget. A
    // filename in a text block would leave them exactly as blind as the
    // four-minute PIE loop did.
    ue = scriptedUe().replies('ui_render_widget_to_png', {
      out_path: 'D:/x.png',
      width: 320,
      height: 240,
      coverage_percent: 42.5,
      image_base64: PNG_B64,
    });

    const r = await uiRenderWidgetToPngHandler({ widget_blueprint_path: BP }, {} as never);
    const { image, text } = blocks(r);
    expect(image?.data).toBe(PNG_B64);
    expect(image?.mimeType).toBe('image/png');
    // The base64 must NOT also be serialised into the text block: the transport
    // length-caps text, which is what destroyed every screenshot last time.
    expect(text).not.toContain(PNG_B64);
    expect(JSON.parse(text)).toMatchObject({ out_path: 'D:/x.png', coverage_percent: 42.5 });
  });

  it('keeps the metadata readable when no image came back', async () => {
    ue = scriptedUe().replies('ui_render_widget_to_png', {
      out_path: 'D:/x.png',
      inline_image_skipped: 'too big',
    });
    const r = await uiRenderWidgetToPngHandler(
      { widget_blueprint_path: BP, inline_image: false },
      {} as never,
    );
    const { image, text } = blocks(r);
    expect(image).toBeUndefined();
    expect(JSON.parse(text).inline_image_skipped).toBe('too big');
  });

  it('surfaces the blank-render warning rather than hiding it behind a success', async () => {
    // A widget that drew nothing still produces a valid, correctly-sized PNG.
    // If this warning gets dropped, the caller sees a confident success for an
    // empty image.
    ue = scriptedUe().replies('ui_render_widget_to_png', {
      out_path: 'D:/x.png',
      coverage_percent: 0,
      warning: 'The widget drew NOTHING',
      image_base64: PNG_B64,
    });
    const r = await uiRenderWidgetToPngHandler({ widget_blueprint_path: BP }, {} as never);
    expect(blocks(r).text).toContain('drew NOTHING');
  });

  it('passes sizing options straight through', async () => {
    ue = scriptedUe().replies('ui_render_widget_to_png', { out_path: 'x' });
    await uiRenderWidgetToPngHandler(
      { widget_blueprint_path: BP, width: 800, height: 600, scale: 2, opaque_background: false },
      {} as never,
    );
    expect(ue.paramsFor('ui_render_widget_to_png')).toMatchObject({
      widget_blueprint_path: BP,
      width: 800,
      height: 600,
      scale: 2,
      opaque_background: false,
    });
  });

  it('rejects a call with no blueprint path without contacting UE', async () => {
    ue = scriptedUe();
    const r = await uiRenderWidgetToPngHandler({}, {} as never);
    expect(r.isError).toBe(true);
    expect(ue.calls).toEqual([]);
  });
});
