import { describe, it, expect } from 'vitest';
import { wrapScriptForPrintRedirect } from './python-run.js';

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
