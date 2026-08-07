import { describe, it, expect, vi } from 'vitest';
import { wrapScriptForPrintRedirect } from './python-run.js';

// Installed on the ToolExecutor seam rather than mocking the tcp-client module
// — same (cmd, params, timeoutMs) signature, so the assertions are unchanged.
const send = vi.fn();
import { setDefaultSender } from '../tool-executor.js';

describe('wrapScriptForPrintRedirect', () => {
  it('injects unreal.log_warning shim for builtin print', () => {
    const wrapped = wrapScriptForPrintRedirect('print("hello")');
    expect(wrapped).toContain('import unreal as _hayba_unreal');
    expect(wrapped).toContain('def _hayba_print(*args, **kwargs):');
    expect(wrapped).toContain('_hayba_unreal.log_warning(');
    expect(wrapped).toContain('"print": _hayba_print');
  });

  it('preserves the user script verbatim inside a triple-quoted block', () => {
    const userScript = 'x = 1 + 2\nprint(x)';
    const wrapped = wrapScriptForPrintRedirect(userScript);
    // Source string is passed unchanged into a """...""" literal — no
    // indentation rewriting that could break the user's intent.
    expect(wrapped).toContain('"""x = 1 + 2\nprint(x)"""');
  });

  it('escapes embedded triple-quotes so the wrap cannot be broken out of', () => {
    const userScript = 'doc = """trap"""';
    const wrapped = wrapScriptForPrintRedirect(userScript);
    expect(wrapped).not.toContain('"""trap"""');
    expect(wrapped).toContain('\\"\\"\\"trap\\"\\"\\"');
  });

  it('escapes backslashes so raw paths survive', () => {
    const userScript = 'p = "C:\\Users\\me"';
    const wrapped = wrapScriptForPrintRedirect(userScript);
    expect(wrapped).toContain('C:\\\\Users\\\\me');
  });

  it('snapshot-style: minimal script produces the expected wrap shape', () => {
    const wrapped = wrapScriptForPrintRedirect('print(1)');
    expect(wrapped.split('\n')).toEqual([
      'import unreal as _hayba_unreal',
      'def _hayba_print(*args, **kwargs):',
      '    sep = kwargs.get("sep", " ")',
      '    _hayba_unreal.log_warning(sep.join(str(a) for a in args))',
      '_hayba_user_globals = {"__name__": "__main__", "print": _hayba_print, "unreal": _hayba_unreal}',
      '_hayba_user_src = """print(1)"""',
      'exec(compile(_hayba_user_src, "<python_run>", "exec"), _hayba_user_globals)',
    ]);
  });
});

describe('python_run crash guard + spill', () => {
  it('refuses a known-crasher script without contacting UE', async () => {
    const { pythonRunHandler } = await import('./python-run.js');
    send.mockClear();
    setDefaultSender(send);
    const r = await pythonRunHandler({ script: 'm.build_scale3d(v)' }, {} as never);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('known editor-crasher');
    expect(send).not.toHaveBeenCalled();
  });

  it('allows the crasher through when allow_unsafe is set', async () => {
    const { pythonRunHandler } = await import('./python-run.js');
    send.mockClear();
    setDefaultSender(send);
    send.mockResolvedValueOnce({ ok: true, data: { ok: true, stdout: 'done' } });
    const r = await pythonRunHandler({ script: 'm.build_scale3d(v)', allow_unsafe: true }, {} as never);
    expect(r.isError).toBeFalsy();
    expect(send).toHaveBeenCalled();
  });

  it('spills oversized output to a temp file and returns a path', async () => {
    const { pythonRunHandler } = await import('./python-run.js');
    send.mockClear();
    setDefaultSender(send);
    send.mockResolvedValueOnce({ ok: true, data: { ok: true, stdout: 'x'.repeat(20_000) } });
    const r = await pythonRunHandler({ script: 'print("big")' }, {} as never);
    expect(r.content[0].text).toContain('Full output written to:');
    expect(r.content[0].text).toContain('output truncated');
  });

  it('returns small output inline', async () => {
    const { pythonRunHandler } = await import('./python-run.js');
    send.mockClear();
    setDefaultSender(send);
    send.mockResolvedValueOnce({ ok: true, data: { ok: true, stdout: 'small' } });
    const r = await pythonRunHandler({ script: 'print("small")' }, {} as never);
    expect(r.content[0].text).toContain('small');
    expect(r.content[0].text).not.toContain('Full output written to:');
  });
});
