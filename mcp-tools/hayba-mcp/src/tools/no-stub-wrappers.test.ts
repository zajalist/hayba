import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A wrapper must not advertise a command the C++ cannot actually perform.
//
// This nearly happened. A sweep for "implemented in C++ but missing a wrapper"
// flagged editor_live_compile as free capability, and the handler said it was
// not possible: compile_started:false, "programmatic trigger not exposed in UE
// 5.4+". Wrapping a command that always fails is worse than the gap it closes.
//
// That reason turned out to be FALSE. LiveCoding.Compile triggers a compile
// perfectly well, and editor_run_console_command had been the documented way to
// do it all along — the handler was the only thing refusing. It now works, so it
// has left this list. The near-miss is still worth remembering, but the lesson
// changed shape: a handler's own explanation of why it cannot do something is a
// claim like any other, and this one went unchecked long enough to become a
// denylist entry and a test comment.
//
// Detecting these needs more than grepping for "not_implemented", because the
// honest stubs say that and the misleading ones do not.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const HANDLER_DIR = join(
  REPO_ROOT, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private', 'handlers',
);
// Satellite plugins carry their own handlers, and their stubs are stubs too.
const SATELLITE_HANDLER_DIRS = [
  join(REPO_ROOT, 'unreal', 'HaybaMCPMetaSound', 'Source', 'HaybaMCPMetaSound', 'Private'),
  join(REPO_ROOT, 'unreal', 'HaybaMCPGAS', 'Source', 'HaybaMCPGAS', 'Private'),
];

/** Commands whose C++ cannot do the thing their name claims. Wrapping any of
 *  these is a bug; delete the entry only when the handler genuinely works.
 *
 *  Kept deliberately short. foliage_add_instance and foliage_paint_at were on
 *  this list for one commit because a heuristic sweep misclassified them; both
 *  are fully implemented, and the second assertion below is what caught it. A
 *  denylist that silently suppresses working capability is the same kind of
 *  quiet wrongness as a tool that reports success without doing anything. */
const KNOWN_STUBS = [
  // Returns status:"deferred" pointing at scene_export, for every call.
  'level_get_spatial_index',
  // The HaybaMCPMetaSound satellite declares six commands; these four answer
  // "pending MetaSoundFrontendDocumentBuilder API stability" every time.
  // Verified live 2026-08-08. metasound_list and metasound_create do work.
  'metasound_add_node',
  'metasound_connect',
  'metasound_set_input',
  'metasound_compile',
  // Returns an error naming the limit: World Partition cell loading is
  // interactive-only in the editor. Honest, but still a command that can never
  // succeed, so nothing should wrap it as capability.
  'wp_load_cell',
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
    const readCpp = (dir: string): string =>
      readdirSync(dir)
        .filter((f) => f.endsWith('.cpp'))
        .map((f) => readFileSync(join(dir, f), 'utf-8'))
        .join('\n');
    const sources = [HANDLER_DIR, ...SATELLITE_HANDLER_DIRS].map(readCpp).join('\n');

    const stillStubbed = KNOWN_STUBS.filter((s) => {
      // Each entry needs a marker that is specific to how THAT handler declines,
      // because the honest stubs phrase it differently and a generic grep for
      // "not_implemented" misses them. If a handler is reworked, its marker
      // disappears and this test starts failing — which is the point.
      if (s === 'level_get_spatial_index') return /SetStringField\(TEXT\("status"\), TEXT\("deferred"\)\)/.test(sources);
      if (s === 'wp_load_cell') return /wp_load_cell: not implemented/.test(sources);
      if (s.startsWith('metasound_')) return new RegExp(`${s}: pending MetaSoundFrontendDocumentBuilder`).test(sources);
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
