import { describe, it, expect, beforeEach } from 'vitest';
import { makePyToolHandler } from '../py-tool-factory.js';
import { setDefaultSender, NON_IDEMPOTENT, type Sender } from '../tool-executor.js';
import {
  assetCreateFolderDescriptor,
  assetOpenEditorDescriptor,
  assetGetSourcePathDescriptor,
  assetPyDescriptors,
  ASSET_NON_IDEMPOTENT,
} from './asset-py-tools.js';
import { assetSaveHandler } from './asset-save.js';

// Canned-stdout sender driving the HAYBA_JSON parse path; captures the last
// script so we can assert on generated python (mirrors editor-py-tools.test.ts).
function mockStdout(stdout: string): { sender: Sender; lastScript: () => string } {
  let script = '';
  const sender: Sender = (async (_cmd, params: Record<string, unknown>) => {
    script = String((params as { script?: string }).script ?? '');
    return { id: 'inmem', ok: true, data: { ok: true, stdout, stderr: '' } };
  }) as Sender;
  return { sender, lastScript: () => script };
}

function emit(obj: unknown): string {
  return `noise\nHAYBA_JSON:${JSON.stringify(obj)}\ntrailing`;
}

beforeEach(() => setDefaultSender(undefined as never));

describe('asset_save (native C++)', () => {
  it('puts the named paths on the asset_save wire command, never python_run', async () => {
    const calls: Array<{ cmd: string; params: Record<string, unknown> }> = [];
    setDefaultSender((async (cmd: string, params: Record<string, unknown>) => {
      calls.push({ cmd, params });
      return { id: 'inmem', ok: true, data: { ok: true, saved: ['/Game/A'], saved_count: 1, skipped: [], failed: [], verified: true } };
    }) as Sender);
    const res = await assetSaveHandler({ asset_paths: ['/Game/A'] }, undefined as never);
    expect(res.isError).toBeUndefined();
    expect(calls).toEqual([{ cmd: 'asset_save', params: { asset_paths: ['/Game/A'] } }]);
  });

  it('has no save-everything mode: paths are required', async () => {
    setDefaultSender((async () => { throw new Error('must not reach the editor'); }) as Sender);
    expect((await assetSaveHandler({}, undefined as never)).isError).toBe(true);
    expect((await assetSaveHandler({ asset_paths: [] }, undefined as never)).isError).toBe(true);
  });

  it('is no longer a python descriptor, and stays retry-safe', () => {
    expect(assetPyDescriptors.map((d) => d.name)).not.toContain('asset_save');
    expect(NON_IDEMPOTENT.has('asset_save')).toBe(false);
  });
});

describe('asset_create_folder', () => {
  it('requires a path and calls make_directory', async () => {
    const missing = await makePyToolHandler(assetCreateFolderDescriptor)({});
    expect(missing.isError).toBe(true);
    const { sender, lastScript } = mockStdout(emit({ ok: true, path: '/Game/New', created: true, already_existed: false }));
    setDefaultSender(sender);
    await makePyToolHandler(assetCreateFolderDescriptor)({ path: '/Game/New' });
    const s = lastScript();
    expect(s).toContain('make_directory');
    expect(s).toContain('does_directory_exist');
    expect(s).toContain("_path = '/Game/New'");
  });
});

describe('asset_open_editor', () => {
  it('requires a non-empty asset_paths array', async () => {
    const res = await makePyToolHandler(assetOpenEditorDescriptor)({ asset_paths: [] });
    expect(res.isError).toBe(true);
  });

  it('opens editors via AssetEditorSubsystem', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, opened: true, count: 1, missing: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(assetOpenEditorDescriptor)({ asset_paths: ['/Game/A'] });
    const s = lastScript();
    expect(s).toContain('AssetEditorSubsystem');
    expect(s).toContain('open_editor_for_assets');
  });
});

describe('asset_get_source_path', () => {
  it('requires asset_path and probes AssetImportData accessors', async () => {
    const missing = await makePyToolHandler(assetGetSourcePathDescriptor)({});
    expect(missing.isError).toBe(true);
    const { sender, lastScript } = mockStdout(emit({ ok: true, asset_path: '/Game/A', has_import_data: true, source_paths: ['C:/x.fbx'], count: 1 }));
    setDefaultSender(sender);
    await makePyToolHandler(assetGetSourcePathDescriptor)({ asset_path: '/Game/A' });
    const s = lastScript();
    expect(s).toContain('asset_import_data');
    expect(s).toContain('get_first_filename');
    expect(s).toContain('extract_filenames');
  });
});

describe('asset-domain factory catalog', () => {
  it('exports 3 net-new tools with unique names (asset_save went native)', () => {
    const names = assetPyDescriptors.map((d) => d.name);
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3);
  });

  it('every tool has a 30s timeout and structured returns', () => {
    for (const d of assetPyDescriptors) {
      expect(d.timeoutMs).toBe(30_000);
      expect(d.returns).toContain('ok');
    }
  });

  it('declares no non-idempotent tools', () => {
    expect(ASSET_NON_IDEMPOTENT).toHaveLength(0);
  });
});
