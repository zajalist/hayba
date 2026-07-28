// Asset-graph tool tests, driven through the ToolExecutor seam.
//
// These seven had no tests, and three of them move or rewrite assets on disk —
// the highest-consequence operations in the toolkit and the ones a user is least
// able to undo by hand. Nothing here needs a running editor.

import { describe, it, expect, afterEach } from 'vitest';
import { scriptedUe, type ScriptedUe } from '../testing/scripted-ue.js';
import { NON_IDEMPOTENT, UeToolError } from '../tool-executor.js';
import { assetFixRedirectorsHandler, meta as fixMeta } from './asset-fix-redirectors.js';
import { assetGetDependenciesHandler, meta as depsMeta } from './asset-get-dependencies.js';
import { assetGetReferencersHandler, meta as refsMeta } from './asset-get-referencers.js';
import { assetGetReferencesHandler, meta as referencesMeta } from './asset-get-references.js';
import { assetMoveHandler, meta as moveMeta } from './asset-move.js';
import { assetRenameHandler, meta as renameMeta } from './asset-rename.js';
import { assetValidateHandler, meta as validateMeta } from './asset-validate.js';
import type { SessionManager, ToolHandler } from '../types.js';

const session = {} as SessionManager;
let ue: ScriptedUe;
afterEach(() => ue?.restore());

function payload(r: { content: Array<{ text?: string }> }): Record<string, unknown> {
  return JSON.parse(r.content[0]!.text!) as Record<string, unknown>;
}

const TOOLS: Array<{ cmd: string; handler: ToolHandler; args: Record<string, unknown>; mutates: boolean }> = [
  { cmd: 'asset_get_dependencies', handler: assetGetDependenciesHandler, args: { path: '/Game/A' }, mutates: false },
  { cmd: 'asset_get_referencers', handler: assetGetReferencersHandler, args: { path: '/Game/A' }, mutates: false },
  { cmd: 'asset_get_references', handler: assetGetReferencesHandler, args: { path: '/Game/A' }, mutates: false },
  { cmd: 'asset_validate', handler: assetValidateHandler, args: { path: '/Game/A' }, mutates: false },
  { cmd: 'asset_rename', handler: assetRenameHandler, args: { path: '/Game/A', new_name: 'B' }, mutates: true },
  { cmd: 'asset_move', handler: assetMoveHandler, args: { path: '/Game/A', target_dir: '/Game/Sub' }, mutates: true },
  { cmd: 'asset_fix_redirectors', handler: assetFixRedirectorsHandler, args: { path: '/Game' }, mutates: true },
];

describe('every asset-graph wrapper reaches the command it claims', () => {
  for (const t of TOOLS) {
    it(`sends ${t.cmd}`, async () => {
      ue = scriptedUe().replies(t.cmd, { ok: true });
      await t.handler(t.args, session);
      expect(ue.calls.map((c) => c.cmd)).toEqual([t.cmd]);
    });
  }
});

describe('arguments survive the trip', () => {
  it('rename forwards both the source path and the new name', async () => {
    ue = scriptedUe().replies('asset_rename', { ok: true, renamed: '/Game/B' });
    await assetRenameHandler({ path: '/Game/Props/SM_Rock', new_name: 'SM_Boulder' }, session);
    expect(ue.paramsFor('asset_rename')).toMatchObject({ path: '/Game/Props/SM_Rock', new_name: 'SM_Boulder' });
  });

  it('move forwards the destination directory', async () => {
    ue = scriptedUe().replies('asset_move', { ok: true, moved_to: '/Game/Env/SM_Rock' });
    await assetMoveHandler({ path: '/Game/Props/SM_Rock', target_dir: '/Game/Env' }, session);
    expect(ue.paramsFor('asset_move')).toMatchObject({ target_dir: '/Game/Env' });
  });
});

describe('bad arguments never reach the engine', () => {
  // asset_fix_redirectors is excluded deliberately: its path is optional because
  // scanning the whole project is a legitimate call. Every other tool here acts
  // on one named asset and has nothing sensible to do without it.
  for (const t of TOOLS.filter((t) => t.cmd !== 'asset_fix_redirectors')) {
    it(`${t.cmd} refuses a missing path`, async () => {
      ue = scriptedUe().replies(t.cmd, { ok: true });
      const r = await t.handler({}, session);
      expect(r.isError).toBe(true);
      // The important half: a destructive command must not be dispatched at all
      // when its arguments are incomplete.
      expect(ue.calls).toHaveLength(0);
    });
  }

  it('rename refuses an empty new_name rather than renaming to nothing', async () => {
    ue = scriptedUe().replies('asset_rename', { ok: true });
    const r = await assetRenameHandler({ path: '/Game/A', new_name: '' }, session);
    expect(r.isError).toBe(true);
    expect(ue.calls).toHaveLength(0);
  });
});

describe('destructive asset operations must not be retried', () => {
  // The executor retries once on transport failure, but only for commands NOT
  // in NON_IDEMPOTENT. A move or rename that lands and then loses its reply
  // would be re-sent, and the second attempt operates on a path that no longer
  // exists — reporting failure for work that actually succeeded.
  it('rename and move are registered non-idempotent', () => {
    expect(NON_IDEMPOTENT.has('asset_rename')).toBe(true);
    expect(NON_IDEMPOTENT.has('asset_move')).toBe(true);
  });

  it('a dropped socket on move is reported once, not re-sent', async () => {
    ue = scriptedUe().disconnects('asset_move');
    await expect(assetMoveHandler({ path: '/Game/A', target_dir: '/Game/B' }, session)).rejects.toBeInstanceOf(
      UeToolError,
    );
    expect(ue.calls.filter((c) => c.cmd === 'asset_move')).toHaveLength(1);
  });

  it('a read is allowed to retry, since repeating it costs nothing', async () => {
    ue = scriptedUe().disconnects('asset_get_referencers');
    await expect(assetGetReferencersHandler({ path: '/Game/A' }, session)).rejects.toBeInstanceOf(UeToolError);
    expect(ue.calls.filter((c) => c.cmd === 'asset_get_referencers')).toHaveLength(2);
  });
});

describe('what happens when UE does not cooperate', () => {
  it('surfaces a refusal rather than reporting a rename that did not happen', async () => {
    ue = scriptedUe().fails('asset_rename', 'target name already exists');
    await expect(assetRenameHandler({ path: '/Game/A', new_name: 'B' }, session)).rejects.toBeInstanceOf(UeToolError);
  });

  it('passes a bare ok through without inventing detail', async () => {
    ue = scriptedUe().silentlySucceeds('asset_move');
    const r = await assetMoveHandler({ path: '/Game/A', target_dir: '/Game/B' }, session);
    expect(payload(r)).toEqual({});
  });

  it('preserves a reported zero — nothing to fix is an answer, not an error', async () => {
    ue = scriptedUe().replies('asset_fix_redirectors', { ok: true, fixed: 0, scanned: 812 });
    const r = await assetFixRedirectorsHandler({ path: '/Game' }, session);
    expect(payload(r)).toMatchObject({ fixed: 0, scanned: 812 });
    expect(r.isError).toBeFalsy();
  });
});

describe('declared effects match what the tool does', () => {
  // Statically imported rather than resolved from the command name: a dynamic
  // path that fails to resolve would skip the tool and pass vacuously, which is
  // the failure mode this whole contract exists to prevent.
  const METAS: Array<[string, { effects: string[] }, boolean]> = [
    ['asset_get_dependencies', depsMeta, false],
    ['asset_get_referencers', refsMeta, false],
    ['asset_get_references', referencesMeta, false],
    ['asset_validate', validateMeta, false],
    ['asset_rename', renameMeta, true],
    ['asset_move', moveMeta, true],
    ['asset_fix_redirectors', fixMeta, true],
  ];

  it('covers every tool under test', () => {
    expect(METAS.map(([c]) => c).sort()).toEqual(TOOLS.map((t) => t.cmd).sort());
  });

  for (const [cmd, meta, mutates] of METAS) {
    it(`${cmd} declares ${mutates ? 'an effect' : 'no effects'}`, () => {
      expect(meta.effects.length > 0, `${cmd} effects disagree with what it does`).toBe(mutates);
    });
  }
});
