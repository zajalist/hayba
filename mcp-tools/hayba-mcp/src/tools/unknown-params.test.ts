import { describe, it, expect } from 'vitest';
import { unknownParamKeys, withUnknownParamWarning } from './unknown-params.js';

const res = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: false });

/** Join only the TEXT parts. ToolContent is a union; images have no .text. */
const textOf = (r: { content: ReadonlyArray<{ type: string }> }): string =>
  r.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text).join('');


describe('unknownParamKeys', () => {
  it('finds a misspelled optional parameter', () => {
    // The case that motivated this: verified live, `rotaton` was accepted and
    // the actor spawned at the default rotation reporting success.
    expect(unknownParamKeys({ location: [0, 0, 0], rotaton: [0, 45, 0] },
      ['class_path', 'location', 'rotation'])).toEqual(['rotaton']);
  });

  it('says nothing when every key is known', () => {
    expect(unknownParamKeys({ location: [0, 0, 0], rotation: [0, 45, 0] },
      ['location', 'rotation'])).toEqual([]);
  });

  it('ignores transport plumbing that is not a tool parameter', () => {
    // A false positive here would fire on every single call, which is the
    // fastest way to make a warning invisible.
    expect(unknownParamKeys({ session_id: 'x', _meta: {}, location: [0, 0, 0] },
      ['location'])).toEqual([]);
  });

  it('returns them sorted, so the message is stable', () => {
    expect(unknownParamKeys({ zeta: 1, alpha: 2 }, [])).toEqual(['alpha', 'zeta']);
  });

  it('accepts an alias as known', () => {
    // Aliases are documented spellings. Reporting one as ignored would be
    // actively wrong — the call DID honour it.
    expect(unknownParamKeys({ widget_class: 'X' },
      ['child_class', 'widget_class'])).toEqual([]);
  });
});

describe('withUnknownParamWarning', () => {
  it('leaves a clean result completely untouched', () => {
    const r = res('done');
    expect(withUnknownParamWarning(r, [], ['a'])).toBe(r);
  });

  it('says the result did not account for the ignored key', () => {
    // The important half of the message. "Unknown parameter" alone reads as
    // pedantry; what matters is that the answer above is not what was asked for.
    const out = withUnknownParamWarning(res('spawned'), ['rotaton'], ['rotation']);
    const text = textOf(out);
    expect(text).toContain('did NOT take it into account');
    expect(text).toContain('"rotaton"');
    expect(text).toContain('Accepted: rotation');
  });

  it('keeps the original content', () => {
    const out = withUnknownParamWarning(res('IMPORTANT-PAYLOAD'), ['x'], ['y']);
    expect(textOf(out)).toContain('IMPORTANT-PAYLOAD');
  });

  it('preserves the error flag', () => {
    const out = withUnknownParamWarning(
      { content: [{ type: 'text', text: 'failed' }], isError: true }, ['x'], ['y']);
    expect(out.isError).toBe(true);
  });

  it('uses plural wording for several keys', () => {
    const text = textOf(withUnknownParamWarning(res('ok'), ['a', 'b'], ['c']));
    expect(text).toContain('Parameters');
    expect(text).toContain('were dropped');
  });
});
