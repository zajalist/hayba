import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { STANDARD_DESCRIPTORS, inferDir } from '../index.js';
import { setDefaultSender } from '../tool-executor.js';
import { chooserInspectDescriptor } from './chooser-inspect.js';
import { scanPythonForCrashers } from '../guards/known-crashers.js';

afterEach(() => setDefaultSender(undefined as never));

const trustedScript = readFileSync(new URL('../../../../../unreal/HaybaMCPToolkit/Resources/Python/hayba_chooser_inspect.py', import.meta.url), 'utf8');

// These doubles execute the emitted Python; native API availability is separately
// verified against UE5.9 headers/PyGenUtil and the disposable-editor probe.
const fixture = `
import sys, types, json
case = json.loads(sys.argv[1])
class ChooserTable:
    def get_path_name(self): return "/Game/Test/CT.CT"
    def get_class(self): return self
class Library:
    @staticmethod
    def get_num_rows(a): return case.get("rows", 5)
    @staticmethod
    def get_num_columns(a): return case.get("columns", 3)
    @staticmethod
    def get_result_type(a): return "ObjectResult"
    @staticmethod
    def get_result_class(a): return None
    @staticmethod
    def get_num_parameters(a): return 1
    @staticmethod
    def get_column_type(a, c): return "/Script/Chooser.BoolColumn"
    @staticmethod
    def get_column_input_type(a, c): return "/Script/Chooser.BoolContextProperty"
    @staticmethod
    def is_column_disabled(a, c): return False
    @staticmethod
    def get_column_input_binding(a, c): return None if c == 0 else (0, ["Speed"] * case.get("binding_length", 1))
    @staticmethod
    def is_row_disabled(a, r): return r == 1
    @staticmethod
    def get_row_result_type(a, r): return "/Script/Chooser.AssetChooser"
    @staticmethod
    def get_row_result_property(a, r, p): return "(Asset=/Game/Anim/Run.Run)"
    @staticmethod
    def get_cell_value_type(a, c, r):
        assert 0 <= c < case.get("columns", 3) and 0 <= r < case.get("rows", 5)
        return "" if case.get("unavailable") else "bool"
    @staticmethod
    def get_cell_value(a, c, r): return "x" * case.get("text_length", 1)
class Assets:
    @staticmethod
    def does_asset_exist(path): return not case.get("missing_asset")
    @staticmethod
    def load_asset(path):
        assert not case.get("missing_asset"), "missing assets must not reach noisy load_asset"
        if case.get("load_failed"): return None
        if case.get("wrong_class"): return object()
        return ChooserTable()
unreal = types.ModuleType("unreal")
unreal.ChooserTable = ChooserTable
unreal.EditorAssetLibrary = Assets
if not case.get("missing_plugin"): unreal.ChooserTableEditorLibrary = Library
if case.get("missing_api"): del Library.get_cell_value
if case.get("missing_asset_api"): del Assets.does_asset_exist
sys.modules["unreal"] = unreal
`;

async function inspect(args: Record<string, unknown> = {}, scenario: Record<string, unknown> = {}) {
  let dispatched = false;
  setDefaultSender(async (command, params) => {
    dispatched = true;
    expect(command).toBe('chooser_inspect');
    expect(params).not.toHaveProperty('script');
    expect(params).not.toHaveProperty('read_only');
    const script = 'import json as _json\n_hayba_params = _json.loads(' + JSON.stringify(JSON.stringify(params)) + ')\n' + trustedScript;
    expect(scanPythonForCrashers(script)).toBeNull();
    const run = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', fixture + '\n' + script, JSON.stringify(scenario)], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
    });
    expect(run.status, run.stderr).toBe(0);
    return { id: 'fixture', ok: true, data: { ok: true, stdout: run.stdout, stderr: run.stderr } };
  });
  const result = await chooserInspectDescriptor.handler({ path: '/Game/Test/CT', ...args }, undefined as never);
  const content = result.content[0];
  if (content?.type !== 'text') throw new Error('Chooser must return a JSON text result');
  return { result, payload: JSON.parse(content.text), dispatched };
}

describe('Chooser inspection discovery', () => {
  it('registers one inspect-only tool in the Chooser domain', () => {
    const descriptors = STANDARD_DESCRIPTORS.filter((d) => d.name === 'chooser_inspect');
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.meta.effects).toEqual([]);
    expect(inferDir('chooser_inspect')).toBe('chooser');
  });
});

describe('Chooser inspection pages', () => {
  it('returns canonical identity and the exact requested rows, columns, cells and bindings', async () => {
    const { payload } = await inspect({ row_offset: 1, row_limit: 2, column_offset: 1, column_limit: 1 });
    expect(payload).toMatchObject({ ok: true, path: '/Game/Test/CT.CT', row_count: 5, column_count: 3 });
    expect(payload.page).toEqual({ rows: { offset: 1, returned: 2, next_offset: 3 }, columns: { offset: 1, returned: 1, next_offset: 2 } });
    expect(payload.rows.map((r: { index: number }) => r.index)).toEqual([1, 2]);
    expect(payload.rows[0]).toMatchObject({ disabled: true, cells: [{ column: 1, value: { text: 'x', truncated: false } }] });
    expect(payload.columns[0].binding).toMatchObject({ parameter_index: 0, property_chain: [{ text: 'Speed' }], total_segments: 1 });
  });

  it('caps native getter loops and exported text even for very large tables', async () => {
    const { payload } = await inspect({ row_limit: 20, column_limit: 8 }, { rows: 2_000_000_000, columns: 2_000_000_000, text_length: 6000, binding_length: 100 });
    expect(payload.rows).toHaveLength(20);
    expect(payload.columns).toHaveLength(8);
    expect(payload.rows.flatMap((r: { cells: unknown[] }) => r.cells)).toHaveLength(160);
    expect(payload.rows[0].cells[0].value).toMatchObject({ text: 'x'.repeat(512), truncated: true });
    expect(payload.columns[1].binding.property_chain).toHaveLength(32);
    expect(payload.columns[1].binding.truncated).toBe(true);
  });

  it('distinguishes an empty table from a missing asset or API', async () => {
    const { payload } = await inspect({}, { rows: 0, columns: 0 });
    expect(payload).toMatchObject({ ok: true, row_count: 0, column_count: 0, rows: [], columns: [] });
    expect(payload.page.rows.next_offset).toBeNull();
  });

  it('marks unsupported cells unavailable without inventing an empty successful value', async () => {
    const { payload } = await inspect({}, { unavailable: true });
    expect(payload.rows[0].cells[0]).toMatchObject({ available: false, value: null });
  });

  it('does not claim an empty getter return proves that a cell value was read', async () => {
    const { payload } = await inspect({}, { text_length: 0 });
    expect(payload.rows[0].cells[0]).toMatchObject({ available: false, value: { text: '', empty_or_unavailable: true } });
  });

  it.each([
    [{ missing_plugin: true }, 'Chooser'], [{ missing_api: true }, 'get_cell_value'],
    [{ missing_asset: true }, 'not found'], [{ wrong_class: true }, 'ChooserTable'],
    [{ missing_asset_api: true }, 'does_asset_exist'], [{ load_failed: true }, 'could not be loaded'],
    [{ rows: -1 }, 'counts'],
  ] as const)('fails clearly for unavailable inspection %s', async (scenario, message) => {
    const { result, payload } = await inspect({}, scenario);
    expect(result.isError).toBe(true);
    expect(payload.error).toContain(message);
  });

  it('refuses an offset beyond the observed table', async () => {
    const { result, payload } = await inspect({ row_offset: 6 });
    expect(result.isError).toBe(true);
    expect(payload.error).toContain('offset');
  });

  it.each([
    { row_limit: 21 }, { column_limit: 9 }, { row_limit: 0 }, { row_limit: 1.5 },
    { row_offset: -1 }, { column_offset: 2_147_483_648 }, { path: '' }, { path: 'x'.repeat(4097) },
    { script: 'raise RuntimeError("caller code")' }, { script_path: 'caller.py' }, { read_only: false },
  ])('refuses invalid input before editor work %s', async (args) => {
    const { result, dispatched } = await inspect(args);
    expect(result.isError).toBe(true);
    expect(dispatched).toBe(false);
  });
});
