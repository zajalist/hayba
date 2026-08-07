/**
 * The capture step in `registerTools`, which had no test at all.
 *
 * `src/tools/index.test.ts` asserted that `registerTools` is a function. That
 * was the entire coverage of the code path that decides which tools exist —
 * so the whole suite could stay green while the catalogue came out empty.
 *
 * The mechanism used to be a monkey-patch: assign over `server.tool`, run
 * registration, restore the original in a `finally`. It worked, but the real
 * server object spent the window in a mutated state, and the failure mode is
 * silent — a live MCP server whose `tool` method registers into a map nobody
 * reads afterwards. These tests pin the properties that made replacing it with
 * an explicit stand-in worth doing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTools } from '../index.js';
import { __resetSettingsCache } from '../routing/settings-watcher.js';
import { __resetConnectedLatch } from '../check-ue-status.js';

/** Lexical-only index — the default backend probe reaches the network. */
const NO_EMBEDDINGS = { selectBackend: async () => null };

/** Minimal stand-in for McpServer: registration only ever calls `.tool()`. */
function fakeServer() {
  const registered = new Map<string, unknown[]>();
  const server = {
    tool: (name: string, ...rest: unknown[]) => {
      registered.set(name, rest);
    },
  };
  return { server, registered };
}

let dir: string;

beforeEach(() => {
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
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HAYBA_SETTINGS_PATH;
  delete process.env.HAYBA_TOOL_INDEX_DIR;
});

describe('registerTools capture', () => {
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
    const { server, registered } = fakeServer();

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
});
