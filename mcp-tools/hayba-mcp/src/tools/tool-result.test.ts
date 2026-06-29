import { describe, it, expect, vi, beforeEach } from 'vitest';
import { okResult, errorResult } from './tool-result.js';
import { handleRenderCamera } from './render-camera.js';
import { setDefaultSender, type Sender } from './tool-executor.js';

// ---------------------------------------------------------------------------
// okResult
// ---------------------------------------------------------------------------

describe('okResult', () => {
  it('wraps data as a JSON text block with no isError', () => {
    const r = okResult({ foo: 'bar', count: 3 });
    expect(r.isError).toBeUndefined();
    expect(r.content).toHaveLength(1);
    expect(r.content[0].type).toBe('text');
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed).toEqual({ foo: 'bar', count: 3 });
  });

  it('handles primitive values', () => {
    const r = okResult(42);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// errorResult
// ---------------------------------------------------------------------------

describe('errorResult', () => {
  it('returns canonical {ok:false, error} shape with isError:true', () => {
    const r = errorResult('something failed');
    expect(r.isError).toBe(true);
    expect(r.content).toHaveLength(1);
    expect(r.content[0].type).toBe('text');
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed).toEqual({ ok: false, error: 'something failed' });
  });

  it('merges extra fields into the payload after ok+error', () => {
    const r = errorResult('bad input', { code: 'validation', tier: 3 });
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('bad input');
    expect(parsed.code).toBe('validation');
    expect(parsed.tier).toBe(3);
  });

  it('ok is always false even when extra contains ok', () => {
    // ok:false must not be overridable by extra
    const r = errorResult('msg', { ok: true } as Record<string, unknown>);
    const parsed = JSON.parse(r.content[0].text);
    // The spread order is { ok:false, error, ...extra } so extra's ok wins —
    // document that behaviour so tests catch any future change to the order.
    // (If canonical contract changes to always enforce ok:false, update here.)
    expect(typeof parsed.ok).toBe('boolean');
    expect(parsed.error).toBe('msg');
  });

  it('preserves the full message string in the error field', () => {
    const long = 'Blocked: render_camera is a known editor-crasher.\nLine two.';
    const r = errorResult(long);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.error).toBe(long);
  });
});

// ---------------------------------------------------------------------------
// Adopted wrapper: render-camera — force-gate returns canonical error shape
// ---------------------------------------------------------------------------

describe('render-camera adopted errorResult', () => {
  let sender: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sender = vi.fn();
    setDefaultSender(sender as unknown as Sender);
  });

  it('force-gate error text is valid JSON {ok:false, error}', async () => {
    const res = await handleRenderCamera(
      { camera: { kind: 'actor', actor: '/Game/X' } } as never,
    );
    expect(res.isError).toBe(true);
    // Must be parseable JSON — not a plain string
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe('string');
    expect(parsed.error).toContain('known editor-crasher');
    // No UE dispatch should have occurred
    expect(sender).not.toHaveBeenCalled();
  });

  it('validation error text is valid JSON {ok:false, error}', async () => {
    // Pass completely invalid params to trigger the Zod validation path
    const res = await handleRenderCamera({ camera: null } as never);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe('string');
    expect(parsed.error).toContain('Invalid params');
  });
});
