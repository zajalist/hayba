import { describe, it, expect, beforeEach } from 'vitest';
import { makePyToolHandler } from '../py-tool-factory.js';
import { setDefaultSender, NON_IDEMPOTENT, type Sender } from '../tool-executor.js';
import {
  editorGetStateDescriptor,
  editorGetCameraDescriptor,
  editorCvarGetDescriptor,
  editorCvarSetDescriptor,
  selectionGetDescriptor,
  assetRegistryQueryDescriptor,
  assetInspectDescriptor,
  outlinerTreeDescriptor,
  objectInspectDescriptor,
  objectExistsDescriptor,
  contentBrowserSyncDescriptor,
  reflectSearchTypesDescriptor,
  reflectClassDescriptor,
  editorPyDescriptors,
  EDITOR_NON_IDEMPOTENT,
} from './editor-py-tools.js';

// Canned-stdout sender driving the HAYBA_JSON parse path; also captures the last
// script so we can assert on generated python (mirrors actor-py-tools.test.ts).
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

describe('editor_get_state', () => {
  it('takes no params and probes map/pie/selection/dirty', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, map: '/Game/Map', pie_running: false, selection_count: 0, dirty_packages: [], dirty_count: 0 }));
    setDefaultSender(sender);
    const res = await makePyToolHandler(editorGetStateDescriptor)({});
    expect(res.isError).toBeUndefined();
    const s = lastScript();
    expect(s).toContain('UnrealEditorSubsystem');
    expect(s).toContain('LevelEditorSubsystem');
    expect(s).toContain('get_dirty_content_packages');
    expect(s).toContain('is_in_play_in_editor');
  });
});

describe('editor_get_camera', () => {
  it('reads viewport camera info and parses HAYBA_JSON', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, location: [1, 2, 3], rotation: [0, 0, 90] }));
    setDefaultSender(sender);
    const res = await makePyToolHandler(editorGetCameraDescriptor)({});
    expect(JSON.parse(res.content[0].text)).toMatchObject({ ok: true, location: [1, 2, 3] });
    expect(lastScript()).toContain('get_level_viewport_camera_info');
  });
});

describe('editor_cvar_get', () => {
  it('defaults to the float getter and marks type_assumed', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, name: 'r.X', type: 'float', value: 1.0 }));
    setDefaultSender(sender);
    await makePyToolHandler(editorCvarGetDescriptor)({ name: 'r.X' });
    const s = lastScript();
    expect(s).toContain("_name = 'r.X'");
    expect(s).toContain('get_console_variable_float_value');
    expect(s).toContain('_type_assumed = True');
  });

  it('picks the int getter when type=int and does not assume', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, value: 2 }));
    setDefaultSender(sender);
    await makePyToolHandler(editorCvarGetDescriptor)({ name: 'r.X', type: 'int' });
    const s = lastScript();
    expect(s).toContain('get_console_variable_int_value');
    expect(s).toContain('_type_assumed = False');
  });

  it('rejects a missing name', async () => {
    const res = await makePyToolHandler(editorCvarGetDescriptor)({});
    expect(res.isError).toBe(true);
  });

  it('probes cvar existence via the string getter and does not trust bare typed values', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, name: 'r.Typo', type: 'float', value: 0, verified: false, note: 'cvar not found' }));
    setDefaultSender(sender);
    const res = await makePyToolHandler(editorCvarGetDescriptor)({ name: 'r.Typo' });
    const s = lastScript();
    // The generated script must attempt an existence probe rather than trusting
    // the typed getter's type-default return value at face value.
    expect(s).toContain('get_console_variable_string_value');
    expect(s).toContain('verified');
    expect(s).toContain('type-default');
    const body = JSON.parse(res.content[0].text) as { verified: boolean };
    expect(body.verified).toBe(false);
  });
});

describe('editor_cvar_set', () => {
  it('runs execute_console_command with a typed value and reads back', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, name: 'r.X', requested: '50', applied: 50 }));
    setDefaultSender(sender);
    const res = await makePyToolHandler(editorCvarSetDescriptor)({ name: 'r.X', value: 50 });
    expect(res.isError).toBeUndefined();
    const s = lastScript();
    expect(s).toContain('execute_console_command');
    expect(s).toContain("_val = '50'");
  });

  it('coerces a boolean value to 1/0', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true }));
    setDefaultSender(sender);
    await makePyToolHandler(editorCvarSetDescriptor)({ name: 'r.Flag', value: true });
    expect(lastScript()).toContain("_val = '1'");
  });

  it('is NOT classified NON_IDEMPOTENT (retry-safe)', () => {
    expect(NON_IDEMPOTENT.has('editor_cvar_set')).toBe(false);
  });

  it('probes existence via the string getter so a typo does not read back as a silent success', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, name: 'r.Typo', requested: '5', applied: 0, verified: false, note: 'cvar not found after set' }));
    setDefaultSender(sender);
    await makePyToolHandler(editorCvarSetDescriptor)({ name: 'r.Typo', value: 5 });
    const s = lastScript();
    expect(s).toContain('get_console_variable_string_value');
    expect(s).toContain('verified');
  });
});

describe('selection_get', () => {
  it('reads actors, assets, and components', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, actors: [], assets: [], components: [], actor_count: 0, asset_count: 0 }));
    setDefaultSender(sender);
    const res = await makePyToolHandler(selectionGetDescriptor)({});
    expect(res.isError).toBeUndefined();
    const s = lastScript();
    expect(s).toContain('get_selected_level_actors');
    expect(s).toContain('get_selected_assets');
    expect(s).toContain('get_selected_components');
  });
});

describe('asset_registry_query', () => {
  it('applies pagination defaults and uses the AssetRegistry', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, assets: [], total: 0, has_more: false, next_offset: 50 }));
    setDefaultSender(sender);
    await makePyToolHandler(assetRegistryQueryDescriptor)({ path_prefix: '/Game/Meshes' });
    const s = lastScript();
    expect(s).toContain('_limit = 50');
    expect(s).toContain('get_asset_registry');
    expect(s).toContain('get_assets_by_path');
    expect(s).toContain("_prefix = '/Game/Meshes'");
  });

  it('embeds a class filter', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, assets: [], total: 0, has_more: false, next_offset: 0 }));
    setDefaultSender(sender);
    await makePyToolHandler(assetRegistryQueryDescriptor)({ class_filter: 'StaticMesh' });
    expect(lastScript()).toContain("_cls = 'StaticMesh'");
  });

  it('embeds a name_contains substring filter (folds in the would-be asset_find)', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, assets: [], total: 0, has_more: false, next_offset: 0 }));
    setDefaultSender(sender);
    await makePyToolHandler(assetRegistryQueryDescriptor)({ name_contains: 'rock' });
    const s = lastScript();
    expect(s).toContain("_name_contains = 'rock'");
    expect(s).toContain('_name_contains.lower() not in nm.lower()');
  });

  it('defaults name_contains to None when omitted', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, assets: [], total: 0, has_more: false, next_offset: 0 }));
    setDefaultSender(sender);
    await makePyToolHandler(assetRegistryQueryDescriptor)({ class_filter: 'StaticMesh' });
    expect(lastScript()).toContain('_name_contains = None');
  });
});

describe('asset_inspect', () => {
  it('requires asset_path and queries deps/refs', async () => {
    const missing = await makePyToolHandler(assetInspectDescriptor)({});
    expect(missing.isError).toBe(true);
    const { sender, lastScript } = mockStdout(emit({ ok: true, asset_path: '/Game/A', class: 'StaticMesh', dirty: false, dep_count: 0, ref_count: 0 }));
    setDefaultSender(sender);
    await makePyToolHandler(assetInspectDescriptor)({ asset_path: '/Game/A' });
    const s = lastScript();
    expect(s).toContain('get_dependencies');
    expect(s).toContain('get_referencers');
    expect(s).toContain('does_asset_exist');
  });
});

describe('outliner_tree', () => {
  it('applies defaults and filters', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, nodes: [], total: 0, has_more: false, next_offset: 50 }));
    setDefaultSender(sender);
    await makePyToolHandler(outlinerTreeDescriptor)({ folder: 'Buildings', class_filter: 'StaticMeshActor' });
    const s = lastScript();
    expect(s).toContain('get_all_level_actors');
    expect(s).toContain('get_attach_parent_actor');
    expect(s).toContain("_folder = 'Buildings'");
    expect(s).toContain('_limit = 50');
  });
});

describe('object_inspect', () => {
  it('requires target and generates a load+dir property dump', async () => {
    const missing = await makePyToolHandler(objectInspectDescriptor)({});
    expect(missing.isError).toBe(true);
    const { sender, lastScript } = mockStdout(emit({ ok: true, object: '/Game/A', class: 'X', properties: [], total: 0, has_more: false, next_offset: 80 }));
    setDefaultSender(sender);
    await makePyToolHandler(objectInspectDescriptor)({ target: '/Game/A' });
    const s = lastScript();
    expect(s).toContain('load_object');
    expect(s).toContain("_target = '/Game/A'");
    expect(s).toContain('_limit = 80');
  });
});

describe('object_exists', () => {
  it('probes asset/object/actor existence', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, exists: true, kind: 'asset', path: '/Game/A' }));
    setDefaultSender(sender);
    const res = await makePyToolHandler(objectExistsDescriptor)({ target: '/Game/A' });
    expect(JSON.parse(res.content[0].text).exists).toBe(true);
    expect(lastScript()).toContain('does_asset_exist');
  });
});

describe('content_browser_sync', () => {
  it('requires a non-empty asset_paths array', async () => {
    const res = await makePyToolHandler(contentBrowserSyncDescriptor)({ asset_paths: [] });
    expect(res.isError).toBe(true);
  });

  it('probes sync_browser_to_objects with the fallback', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, synced: true, count: 1, missing: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(contentBrowserSyncDescriptor)({ asset_paths: ['/Game/A'] });
    const s = lastScript();
    expect(s).toContain('sync_browser_to_objects');
    expect(s).toContain('_paths = ["/Game/A"]');
  });

  it('surfaces a python _err envelope as ok:false', async () => {
    setDefaultSender(mockStdout(emit({ ok: false, error: 'no available content-browser sync API in this build' })).sender);
    const res = await makePyToolHandler(contentBrowserSyncDescriptor)({ asset_paths: ['/Game/A'] });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text).ok).toBe(false);
  });
});

describe('reflect_search_types', () => {
  it('requires a query and searches the unreal module', async () => {
    const missing = await makePyToolHandler(reflectSearchTypesDescriptor)({});
    expect(missing.isError).toBe(true);
    const { sender, lastScript } = mockStdout(emit({ ok: true, matches: [], total: 0, has_more: false }));
    setDefaultSender(sender);
    await makePyToolHandler(reflectSearchTypesDescriptor)({ query: 'Mesh' });
    const s = lastScript();
    expect(s).toContain('dir(unreal)');
    expect(s).toContain("_q = 'Mesh'");
    expect(s).toContain('_limit = 30');
  });
});

describe('reflect_class', () => {
  it('resolves a class and walks the MRO + CDO', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, class: 'StaticMeshComponent', super_chain: [], cdo_summary: [] }));
    setDefaultSender(sender);
    const res = await makePyToolHandler(reflectClassDescriptor)({ class_path: 'StaticMeshComponent' });
    expect(res.isError).toBeUndefined();
    const s = lastScript();
    expect(s).toContain('_resolve_type');
    expect(s).toContain('get_default_object');
    expect(s).toContain('__mro__');
  });
});

describe('editor-domain factory catalog', () => {
  it('exports 13 net-new tools with unique names', () => {
    const names = editorPyDescriptors.map((d) => d.name);
    expect(names).toHaveLength(13);
    expect(new Set(names).size).toBe(13);
  });

  // The real cross-catalog no-duplicates backstop is the global
  // STANDARD_DESCRIPTORS uniqueness check in schema-single-source.test.ts,
  // which walks every descriptor in the tool registry (not a hand-curated
  // list here that can silently drift). This test only checks internal
  // self-consistency of this file's own descriptor array.
  it('has no internal duplicate names (see schema-single-source.test.ts for the global check)', () => {
    const names = editorPyDescriptors.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every tool has a 30s timeout and structured returns', () => {
    for (const d of editorPyDescriptors) {
      expect(d.timeoutMs).toBe(30_000);
      expect(d.returns).toContain('ok');
    }
  });

  it('declares no non-idempotent tools', () => {
    expect(EDITOR_NON_IDEMPOTENT).toHaveLength(0);
  });
});
