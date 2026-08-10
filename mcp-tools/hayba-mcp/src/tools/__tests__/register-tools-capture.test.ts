/**
 * The capture step in `registerTools`, which had no test at all.
 *
 * `src/tools/index.test.ts` asserted that `registerTools` is a function. That
 * was the entire coverage of the code path that decides which tools exist —
 * so the whole suite could stay green while the catalogue came out empty.
 *
 * The mechanism used to be a monkey-patch, then an explicit fake server: run
 * eager registration and intercept `.tool()` merely to discover the catalogue.
 * Both made a value depend on registration timing. The catalogue is now a
 * descriptor value converted directly into a captured map; these tests pin
 * that distinction as behavior, not source-text shape.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../../config.js';
import {
  captureStaticToolCatalogue,
  CODE_MODE_DESCRIPTORS,
  registerTools,
  SPECIAL_EAGER_DESCRIPTORS,
  STANDARD_DESCRIPTORS,
  STATIC_TOOL_CATALOGUE,
} from '../index.js';
import { wrapToolHandlerForStream } from '../tool-stream-mirror.js';
import { __resetDisabledToolsCache } from '../disabled-tools-watcher.js';
import { __resetSettingsCache } from '../routing/settings-watcher.js';
import { __resetConnectedLatch } from '../check-ue-status.js';

/** Lexical-only index — the default backend probe reaches the network. */
const NO_EMBEDDINGS = { selectBackend: async () => null };

/** Minimal stand-in for McpServer: registration only ever calls `.tool()`. */
function fakeServer() {
  const registered = new Map<string, unknown[]>();
  const calls = new Map<string, number>();
  const server = {
    tool: (name: string, ...rest: unknown[]) => {
      registered.set(name, rest);
      calls.set(name, (calls.get(name) ?? 0) + 1);
    },
  };
  return { server, registered, calls };
}

let dir: string;
let originalCodeMode: boolean;

beforeEach(() => {
  originalCodeMode = config.codeMode;
  dir = mkdtempSync(join(tmpdir(), 'hayba-cap-'));
  process.env.HAYBA_SETTINGS_PATH = join(dir, 'settings.json');
  process.env.HAYBA_TOOL_INDEX_DIR = dir;
  writeFileSync(process.env.HAYBA_SETTINGS_PATH, JSON.stringify({
    toolRouting: 'deferred', alwaysLoadPacks: [],
  }));
  __resetSettingsCache();
  __resetConnectedLatch();
});

afterEach(() => {
  config.codeMode = originalCodeMode;
  __resetDisabledToolsCache();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HAYBA_SETTINGS_PATH;
  delete process.env.HAYBA_TOOL_INDEX_DIR;
  delete process.env.HAYBA_DISABLED_TOOLS_PATH;
});

describe('registerTools capture', () => {
  it('constructs the whole static catalogue directly from unique descriptors', () => {
    const captured = captureStaticToolCatalogue({});
    const names = STATIC_TOOL_CATALOGUE.map((d) => d.name);

    expect(new Set(names).size, 'duplicate descriptor names make routing order significant').toBe(names.length);
    expect([...captured.keys()]).toEqual(names);
    expect(captured.size).toBe(
      CODE_MODE_DESCRIPTORS.length + STANDARD_DESCRIPTORS.length + SPECIAL_EAGER_DESCRIPTORS.length,
    );
  });

  it('keeps canonical signatures separate from compatibility-only wire aliases', () => {
    const sig = CODE_MODE_DESCRIPTORS.find((d) => d.name === 'get_tool_signature')!;
    const python = CODE_MODE_DESCRIPTORS.find((d) => d.name === 'python_run')!;

    expect(Object.keys(sig.schema)).toEqual(['command']);
    expect(Object.keys(sig.wireSchema ?? {})).toEqual(['command', 'name']);
    expect(Object.keys(python.schema)).toEqual(['script', 'allow_unsafe']);
    expect(Object.keys(python.wireSchema ?? {})).toEqual(['script', 'code', 'allow_unsafe']);
  });

  it('makes deferred stream wrapping idempotent before a captured tool is pack-loaded', () => {
    const handler = async (_params: unknown) => ({ content: [] });
    const once = wrapToolHandlerForStream('probe', handler);
    expect(wrapToolHandlerForStream('probe', once)).toBe(once);
  });

  it('applies the plugin advisory setting at the shared native/deferred wrapper', async () => {
    const result = {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: 'keep me', warnings: ['hide me'], hint: 'hide me too' }),
      }],
      isError: true,
    };
    const settings = join(dir, 'disabled-tools.json');
    process.env.HAYBA_DISABLED_TOOLS_PATH = settings;
    writeFileSync(settings, JSON.stringify({ disabled: [], advisory_verbosity: 'errors_only' }));
    __resetDisabledToolsCache();

    const wrapped = wrapToolHandlerForStream('advisory_probe', async (_params: unknown) => result);
    const filtered = await wrapped({}) as typeof result;
    expect(JSON.parse(filtered.content[0]!.text)).toEqual({ error: 'keep me' });

    writeFileSync(settings, JSON.stringify({ disabled: [], advisory_verbosity: 'errors_warnings_and_tips' }));
    __resetDisabledToolsCache();
    const full = await wrapped({});
    expect(full, 'full verbosity should preserve the original result identity').toBe(result);
  });

  it('leaves the real server registering, not capturing', async () => {
    const { server, registered } = fakeServer();

    await registerTools(server as never, {} as never, NO_EMBEDDINGS);

    // `server.tool` is deliberately NOT identical afterwards —
    // installToolStreamMirror wraps it so pack-loaded tools get mirrored to the
    // UE Tool Stream panel. Identity is the wrong thing to assert.
    //
    // What matters is that the wrapper still *registers*. The failure the old
    // monkey-patch could produce is a live server whose `tool` method is still
    // the capturing implementation — every later registration would vanish into
    // a map nobody reads, and nothing would throw.
    server.tool('probe_tool_after_registration', {}, async () => ({ content: [] }));

    expect(
      registered.has('probe_tool_after_registration'),
      'a tool registered after registerTools() returned did not reach the server — ' +
        'the capturing implementation is still installed',
    ).toBe(true);
  });

  it('captures the catalogue and registers only the always-on surface', async () => {
    const { server, registered, calls } = fakeServer();

    const handle = await registerTools(server as never, {} as never, NO_EMBEDDINGS);
    expect(handle, 'deferred routing should return a handle').not.toBeNull();

    // Everything reachable, only a handful registered up front. The exact
    // always-on set is asserted by first-install-surface.test.ts; here the
    // point is the ratio — a capture that silently produced nothing would
    // leave the index empty while these registrations still happened.
    const names = [...registered.keys()];
    expect(names).toContain('hayba_invoke');
    expect(names).toContain('hayba_search_tools');
    expect(names.length).toBeLessThan(20);
    expect(
      calls.get('hayba_check_ue_status'),
      'the deferred autoload-aware status replacement must register exactly once',
    ).toBe(1);

    // Asserted through the public search surface rather than an internal count,
    // because "an agent can find a tool it did not register" is the actual
    // property the capture exists to provide.
    const hits = await handle!.index.search('spawn an actor in the level', { k: 5 });
    expect(
      hits.length,
      'the captured catalogue should be searchable — if this is empty the capture ' +
        'ran but wrote nowhere, which is exactly the failure the old monkey-patch ' +
        'could produce while every other test stayed green',
    ).toBeGreaterThan(0);
    expect(names, 'a searchable tool need not be registered').not.toContain(hits[0]!.name);
  });

  it('preserves full eager registration without the deferred status replacement', async () => {
    writeFileSync(process.env.HAYBA_SETTINGS_PATH!, JSON.stringify({
      toolRouting: 'full', alwaysLoadPacks: [],
    }));
    __resetSettingsCache();
    config.codeMode = false;
    const { server, registered, calls } = fakeServer();

    const handle = await registerTools(server as never, {} as never, NO_EMBEDDINGS);

    expect(handle).toBeNull();
    expect([...registered.keys()].sort()).toEqual(STATIC_TOOL_CATALOGUE.map((d) => d.name).sort());
    expect(calls.get('hayba_check_ue_status')).toBe(1);
  });
});
