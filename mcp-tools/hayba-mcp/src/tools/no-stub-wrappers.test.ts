import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A wrapper must not advertise a command the C++ cannot actually perform.
//
// This nearly happened. A sweep for "implemented in C++ but missing a wrapper"
// flagged editor_live_compile as free capability. It is not implemented — the
// handler returns compile_started:false with "use Live Coding (Ctrl+Alt+F11) —
// programmatic trigger not exposed in UE 5.4+". Wrapping it would have put a
// tool in the catalogue that always fails, which is worse than the gap it was
// meant to close: an agent would burn turns discovering it does nothing.
//
// Detecting these needs more than grepping for "not_implemented", because the
// honest stubs say that and the misleading ones do not.

const __dirname = dirname(fileURLToPath(import.meta.url));
const HANDLER_DIR = join(
  __dirname, '..', '..', '..', '..',
  'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private', 'handlers',
);

/** Commands whose C++ cannot do the thing their name claims. Wrapping any of
 *  these is a bug; delete the entry only when the handler genuinely works.
 *
 *  Kept deliberately short. foliage_add_instance and foliage_paint_at were on
 *  this list for one commit because a heuristic sweep misclassified them; both
 *  are fully implemented, and the second assertion below is what caught it. A
 *  denylist that silently suppresses working capability is the same kind of
 *  quiet wrongness as a tool that reports success without doing anything. */
const KNOWN_STUBS = [
  'blueprint_add_node',
  'blueprint_connect_nodes',
  'blueprint_add_event',
  // Returns compile_started:false and points at the manual shortcut.
  'editor_live_compile',
];

function wrapperSources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(p);
      } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
        out.push({ file: p, text: readFileSync(p, 'utf-8') });
      }
    }
  };
  walk(join(__dirname));
  return out;
}

describe('wrappers never advertise a stubbed command', () => {
  it('no executeCommand call targets a known stub', () => {
    const offenders: string[] = [];
    for (const { file, text } of wrapperSources()) {
      for (const stub of KNOWN_STUBS) {
        const call = new RegExp(`executeCommand\\(\\s*['"]${stub}['"]`);
        if (call.test(text)) offenders.push(`${stub} <- ${file}`);
      }
    }
    expect(
      offenders,
      'These wrappers call a command whose C++ handler cannot perform it, so the tool\n' +
        'would appear in the catalogue and always fail:\n  ' + offenders.join('\n  '),
    ).toEqual([]);
  });

  it('the stub list still matches what the C++ actually says', () => {
    // If a handler stops being a stub, this test should start failing so the
    // list gets trimmed and the capability gets wrapped — the whole point is to
    // avoid a stale denylist quietly suppressing real functionality.
    const sources = readdirSync(HANDLER_DIR)
      .filter((f) => f.endsWith('.cpp'))
      .map((f) => readFileSync(join(HANDLER_DIR, f), 'utf-8'))
      .join('\n');

    const stillStubbed = KNOWN_STUBS.filter((s) => {
      // Either the command name sits near a not-implemented marker, or the
      // handler is one we have individually confirmed (live_compile).
      if (s === 'editor_live_compile') return /programmatic trigger not exposed/.test(sources);
      return new RegExp(`${s}[\\s\\S]{0,2000}?not_implemented`).test(sources)
        || new RegExp(`not_implemented[\\s\\S]{0,2000}?${s}`).test(sources);
    });

    const noLongerStubbed = KNOWN_STUBS.filter((s) => !stillStubbed.includes(s));
    expect(
      noLongerStubbed,
      `these are listed as stubs but the C++ no longer looks stubbed — verify and wrap them: ${noLongerStubbed.join(', ')}`,
    ).toEqual([]);
  });
});
