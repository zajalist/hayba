import { afterEach, describe, expect, it } from 'vitest';
import { scriptedUe, type ScriptedUe } from '../testing/scripted-ue.js';
import { isValidBase64, schema, uiRenderWidgetToPngHandler } from './ui-render-widget-to-png.js';

let ue: ScriptedUe | undefined;
afterEach(() => {
  ue?.restore();
  ue = undefined;
});

const BP = '/Game/UI/WBP_Panel';
// 1x1 transparent PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function blocks(r: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }) {
  return {
    image: r.content.find((c) => c.type === 'image'),
    text: r.content.find((c) => c.type === 'text')?.text ?? '',
  };
}

describe('ui_render_widget_to_png', () => {
  it('refuses non-finite, fractional, oversized, and over-budget allocations before UE', () => {
    const base = { widget_blueprint_path: BP };
    expect(() => schema.parse({ ...base, width: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => schema.parse({ ...base, width: 100.5 })).toThrow();
    expect(() => schema.parse({ ...base, width: 4097 })).toThrow();
    expect(() => schema.parse({ ...base, width: 4096, height: 4096 })).toThrow();
    expect(() => schema.parse({ ...base, width: 3840, height: 2160 })).not.toThrow();
    expect(() => schema.parse({ ...base, width: 2048, height: 2048, scale: 2 })).toThrow();
  });

  it('accepts only omitted or clean PNG filenames before UE', () => {
    const base = { widget_blueprint_path: BP };
    expect(() => schema.parse(base)).not.toThrow();
    expect(() => schema.parse({ ...base, out_path: 'widget-proof.png' })).not.toThrow();
    expect(() => schema.parse({ ...base, out_path: 'Saved/Screenshots/gauntlet/widget-proof.png' })).toThrow();
    expect(() =>
      schema.parse({ ...base, out_path: 'D:\\Projects\\Aphrosia\\Saved\\Screenshots\\gauntlet\\widget-proof.png' }),
    ).toThrow();
  });

  it('refuses traversal, invalid types, wrong extensions, controls, and oversized paths before UE', () => {
    const base = { widget_blueprint_path: BP };
    expect(() => schema.parse({ ...base, out_path: '../widget-proof.png' })).toThrow();
    expect(() => schema.parse({ ...base, out_path: 'Saved/Screenshots/../widget-proof.png' })).toThrow();
    expect(() => schema.parse({ ...base, out_path: 'widget-proof.jpg' })).toThrow();
    expect(() => schema.parse({ ...base, out_path: 'widget\nproof.png' })).toThrow();
    expect(() => schema.parse({ ...base, out_path: 42 })).toThrow();
    expect(() => schema.parse({ ...base, out_path: 'CON.png' })).toThrow();
    expect(() => schema.parse({ ...base, out_path: 'NUL.png' })).toThrow();
    expect(() => schema.parse({ ...base, out_path: 'LPT1.anything.png' })).toThrow();
    expect(() => schema.parse({ ...base, out_path: `${'a'.repeat(237)}.png` })).toThrow();
  });

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
    const r = await uiRenderWidgetToPngHandler({ widget_blueprint_path: BP, inline_image: false }, {} as never);
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

  // --- Regression coverage for #334 ------------------------------------
  //
  // Root cause: the response-shaping layer between UE and this handler (a
  // generic per-field string cap applied to every command's JSON response,
  // unreal/HaybaMCPToolkit/.../HaybaMCPCommandHandler.cpp ~line 1024,
  // `Limits.MaxStringChars = 512`) has no exemption for image-carrying
  // commands the way python_run does (line 1034). A base64 PNG is almost
  // always over 512 chars, so it gets clipped mid-string and a non-base64
  // "..." marker appended — producing a field that is non-empty but not
  // valid base64. Handing that straight to the MCP SDK as an `image` content
  // block throws inside the SDK's own response validation ("Invalid Base64
  // string"), which kills the WHOLE tool response — metadata and path
  // included, even though both were fine.
  //
  // unreal/ is out of scope for this fix (cannot be verified without the
  // editor). These tests instead harden the TS handler: (1) a large,
  // well-formed base64 payload must survive completely unmodified through
  // this handler, and (2) a payload matching the observed corruption
  // signature (clipped, non-multiple-of-4, trailing "...") must never reach
  // an `image` content block, and must never take `path` down with it.

  it('a large, well-formed base64 payload survives the handler byte-identical', async () => {
    // ~1.3MB of base64 — comfortably past the 512-char cap that corrupts
    // real screenshots, so this pins that OUR code does not add its own
    // truncation on top of (or instead of) the one already diagnosed.
    const bigPng = 'A'.repeat(1_000_000); // 1,000,000 chars — multiple of 4, len % 4 === 0
    expect(isValidBase64(bigPng)).toBe(true);

    ue = scriptedUe().replies('ui_render_widget_to_png', {
      out_path: 'D:/big.png',
      image_base64: bigPng,
    });

    const r = await uiRenderWidgetToPngHandler({ widget_blueprint_path: BP }, {} as never);
    const { image } = blocks(r);
    expect(image?.data).toBe(bigPng);
    expect(image?.data?.length).toBe(bigPng.length);
  });

  it('drops a clipped/invalid base64 payload instead of building a broken image block', async () => {
    // Mirrors the exact corruption shape: a 512-char field cap keeping the
    // first 509 chars of valid base64 and appending "...". 509 is not a
    // multiple of 4, and "..." is not base64 alphabet — this is what UE
    // currently sends back for any real render.
    const validPrefix = 'A'.repeat(509);
    const clipped = validPrefix + '...';
    expect(isValidBase64(clipped)).toBe(false);

    ue = scriptedUe().replies('ui_render_widget_to_png', {
      out_path: 'D:/x.png',
      image_base64: clipped,
    });

    const r = await uiRenderWidgetToPngHandler({ widget_blueprint_path: BP }, {} as never);
    const { image, text } = blocks(r);
    // No image block was built from the corrupt string — that would have
    // thrown inside the SDK and destroyed this entire response.
    expect(image).toBeUndefined();
    // The corruption is surfaced as text, not silently dropped.
    expect(r.content.some((c) => c.type === 'text' && c.text?.includes('not valid base64'))).toBe(true);
    // And the metadata / path are still intact — the whole point of not
    // routing the bad string through the image block.
    expect(JSON.parse(text).path).toBe('D:/x.png');
  });

  it('always carries a usable "path" the caller can read from disk', async () => {
    ue = scriptedUe().replies('ui_render_widget_to_png', {
      out_path: 'D:/only-metadata.png',
      inline_image_skipped: 'too big',
    });
    const r = await uiRenderWidgetToPngHandler({ widget_blueprint_path: BP, inline_image: false }, {} as never);
    const { text } = blocks(r);
    const parsed = JSON.parse(text);
    expect(parsed.path).toBe('D:/only-metadata.png');
    expect(parsed.out_path).toBe('D:/only-metadata.png');
  });
});

describe('isValidBase64', () => {
  it('accepts valid, correctly padded base64', () => {
    expect(isValidBase64('AAAA')).toBe(true);
    expect(isValidBase64('AAA=')).toBe(true);
    expect(isValidBase64('AA==')).toBe(true);
  });

  it('rejects empty strings, non-multiple-of-4 lengths, and non-base64 characters', () => {
    expect(isValidBase64('')).toBe(false);
    expect(isValidBase64('AAAAA')).toBe(false); // length 5, not a multiple of 4
    expect(isValidBase64('AAA...')).toBe(false); // trailing ellipsis — the observed corruption
    expect(isValidBase64('not base64!!')).toBe(false);
  });
});
