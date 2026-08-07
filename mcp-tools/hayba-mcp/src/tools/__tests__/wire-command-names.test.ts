/**
 * Every command name sent over the wire must be one the plugin implements.
 *
 * `executeCommand(name, ...)` puts `name` on the TCP socket. If the plugin has
 * no such command the call fails with "Unknown command" at runtime — but
 * NOTHING catches it earlier, and unit tests actively hide it: `ScriptedUe`
 * maps arbitrary strings to responses, so `scriptedUe().replies('ui_set_brush',
 * ...)` happily scripts a command that does not exist. The test then passes and
 * confirms the author's wrong model of the system.
 *
 * That is not hypothetical. ui_copy_style and ui_set_default_font shipped
 * dispatching `ui_set_brush` and `ui_set_text_style` over the socket. Those are
 * TS-LAYER TOOL NAMES, not UE commands — they translate onto
 * ui_set_widget_properties before anything reaches the wire. Both tools were
 * dead on arrival, both had green tests, and the failure only surfaced when a
 * human invoked them against a live editor.
 *
 * The rule this encodes: a TS tool name and a UE command name are different
 * namespaces that happen to look alike. Re-dispatching one tool from another
 * goes through the other tool's HANDLER, never through executeCommand.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', '..');
const PLUGIN = join(SRC, '..', '..', '..', 'unreal', 'HaybaMCPToolkit', 'Source');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Every command name the plugin answers to, from C++ TEXT("...") literals plus
 *  the legacy sidecar catalogue. */
function pluginCommands(): Set<string> {
  const cmds = new Set<string>();
  for (const f of walk(PLUGIN)) {
    if (!f.endsWith('.cpp') && !f.endsWith('.h')) continue;
    const src = readFileSync(f, 'utf-8');
    for (const m of src.matchAll(/TEXT\("([a-z][a-z0-9_]{2,})"\)/g)) cmds.add(m[1]!);
  }
  const sidecar = JSON.parse(
    readFileSync(join(SRC, 'legacy-commands', 'sidecar.json'), 'utf-8'),
  ) as { commands: Record<string, unknown> };
  for (const k of Object.keys(sidecar.commands)) cmds.add(k);
  return cmds;
}

/** Every site in non-test source that puts a command name on the wire.
 *
 *  Two forms, and both must be matched or this whole test quietly stops
 *  covering whatever it misses:
 *
 *    executeCommand('actor_delete', ...)        hand-written handlers
 *    ueTool('actor_delete', schema)             pass-through wrappers
 *
 *  ueTool() calls executeCommand internally, so a scan for `executeCommand(`
 *  alone still passes — it just silently exempts every wrapper that adopted the
 *  helper. When 56 wrappers moved to ueTool at once, that would have dropped
 *  them all out of this check without a single test going red. */
function wireCalls(): Array<{ file: string; cmd: string }> {
  const hits: Array<{ file: string; cmd: string }> = [];
  for (const f of walk(join(SRC, 'tools'))) {
    if (!f.endsWith('.ts') || f.includes('.test.')) continue;
    const src = readFileSync(f, 'utf-8');
    // The generic-parameter part must not cross a newline or a paren: `[^>]*`
    // matches newlines, so a loose pattern walked from one executeCommand all
    // the way into an unrelated `startsWith('build_')` many lines below.
    for (const m of src.matchAll(/executeCommand(?:<[^>\n]*>)?\(\s*'([a-z][a-z0-9_]+)'/g)) {
      hits.push({ file: relative(SRC, f).split(sep).join('/'), cmd: m[1]! });
    }
    for (const m of src.matchAll(/\bueTool\(\s*'([a-z][a-z0-9_]+)'/g)) {
      hits.push({ file: relative(SRC, f).split(sep).join('/'), cmd: m[1]! });
    }
  }
  return hits;
}

/**
 * Commands dispatched by tools that the plugin does NOT implement.
 *
 * These are recorded, not tolerated: each entry is a tool that cannot work, and
 * the list exists so a NEW one fails this test loudly instead of joining them.
 * Shrink it; never grow it.
 *
 * Verified live 2026-08-01 — `hayba_fab_login_status` returns
 * "Unknown command: fab_login_status" from the plugin.
 */
const KNOWN_UNIMPLEMENTED = new Set([
  'fab_login_status',
  'fab_library_list',
  'fab_marketplace_search',
  'fab_download',
  'plan_mark_step',
  'hayba_request_input',
  'hayba_get_user_response',
]);

describe('wire command names resolve to real plugin commands', () => {
  const available = existsSync(PLUGIN);

  it.runIf(available)('finds a plausible number of plugin commands (guards the test itself)', () => {
    expect(pluginCommands().size).toBeGreaterThan(300);
  });

  it.runIf(available)('finds the executeCommand call sites (guards the test itself)', () => {
    expect(wireCalls().length).toBeGreaterThan(50);
  });

  it.runIf(available)('no tool dispatches a command the plugin does not implement', () => {
    const known = pluginCommands();
    const offenders = wireCalls()
      .filter(({ cmd }) => !known.has(cmd) && !KNOWN_UNIMPLEMENTED.has(cmd))
      .map(({ file, cmd }) => `${cmd}  (${file})`)
      .sort();

    expect(
      [...new Set(offenders)],
      'These names go over the TCP socket but no plugin command answers to them, so the tool ' +
        'fails with "Unknown command" at runtime. The usual cause is re-dispatching another ' +
        'TS TOOL by name — tool names and UE command names are different namespaces. Call the ' +
        "other tool's handler directly instead.",
    ).toEqual([]);
  });

  it.runIf(available)('the known-unimplemented list stays accurate', () => {
    // If one gets implemented, remove it from the list rather than leaving a
    // stale exemption that could mask a regression.
    const known = pluginCommands();
    const nowImplemented = [...KNOWN_UNIMPLEMENTED].filter((c) => known.has(c));
    expect(
      nowImplemented,
      'These are now implemented by the plugin — delete them from KNOWN_UNIMPLEMENTED.',
    ).toEqual([]);
  });
});
