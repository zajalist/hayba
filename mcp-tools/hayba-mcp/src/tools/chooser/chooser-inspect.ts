import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import type { PyToolDescriptor } from '../py-tool-factory.js';
import { pyStr } from '../ue-python.js';

const schema = z.object({
  path: z.string().trim().min(1).max(4096).describe('Exact ChooserTable asset or object path; discover candidates with asset_registry_query.'),
  row_offset: z.number().int().min(0).max(2_147_483_647).default(0),
  row_limit: z.number().int().min(1).max(20).default(10),
  column_offset: z.number().int().min(0).max(2_147_483_647).default(0),
  column_limit: z.number().int().min(1).max(8).default(8),
});

const readMeta: HaybaToolMeta = {
  cost: 'medium', effects: [], pack: 'chooser',
  when: 'inspecting Chooser table decision rows, filter columns, input bindings and result assets before editing animation or gameplay selection',
  not_when: 'editing a table or validating gameplay behavior; this only reads primary rows and does not evaluate the chooser',
};

// UE5.9 ChooserTableEditorLibrary.h; PyGenUtil::PackReturnValues makes bool+out
// GetColumnInputBinding return None or (parameter_index, property_chain).
function buildScript(p: z.infer<typeof schema>): string {
  return `
def _text(value):
    text = str(value)
    return {"text": text[:512], "truncated": len(text) > 512, "empty_or_unavailable": text == ""}
def _inspect_chooser():
    path = ${pyStr(p.path)}
    if not hasattr(unreal, "ChooserTableEditorLibrary") or not hasattr(unreal, "ChooserTable"):
        _err("Chooser editor scripting unavailable; enable the optional Chooser plugin on UE5.9 and restart the editor. Target: " + path)
        return
    lib = unreal.ChooserTableEditorLibrary
    methods = ("get_num_rows", "get_num_columns", "get_result_type", "get_result_class", "get_num_parameters", "get_column_type", "get_column_input_type", "is_column_disabled", "get_column_input_binding", "is_row_disabled", "get_row_result_type", "get_row_result_property", "get_cell_value_type", "get_cell_value")
    missing = [name for name in methods if not hasattr(lib, name)]
    if missing:
        _err("Chooser editor API unavailable: " + ", ".join(missing) + ". Target: " + path)
        return
    if not hasattr(unreal, "EditorAssetLibrary"):
        _err("EditorAssetLibrary unavailable; enable Editor Scripting Utilities. Target: " + path)
        return
    asset_methods = ("does_asset_exist", "load_asset")
    missing = [name for name in asset_methods if not hasattr(unreal.EditorAssetLibrary, name)]
    if missing:
        _err("EditorAssetLibrary API unavailable: " + ", ".join(missing) + ". Target: " + path)
        return
    if not unreal.EditorAssetLibrary.does_asset_exist(path):
        _err("Chooser asset not found: " + path)
        return
    asset = unreal.EditorAssetLibrary.load_asset(path)
    if asset is None:
        _err("Chooser asset exists but could not be loaded: " + path)
        return
    if not isinstance(asset, unreal.ChooserTable):
        _err("Target is not a ChooserTable: " + path)
        return
    row_count = lib.get_num_rows(asset)
    column_count = lib.get_num_columns(asset)
    if not isinstance(row_count, int) or not isinstance(column_count, int) or row_count < 0 or column_count < 0 or row_count > 2147483647 or column_count > 2147483647:
        _err("Chooser API returned invalid table counts: " + path)
        return
    row_offset = ${p.row_offset}
    column_offset = ${p.column_offset}
    if row_offset > row_count or column_offset > column_count:
        _err("Page offset exceeds Chooser table counts; restart paging at zero. Target: " + path)
        return
    row_end = min(row_count, row_offset + min(${p.row_limit}, 20))
    column_end = min(column_count, column_offset + min(${p.column_limit}, 8))
    columns = []
    for column in range(column_offset, column_end):
        bound = lib.get_column_input_binding(asset, column)
        binding = None
        if bound is not None:
            if not isinstance(bound, tuple) or len(bound) != 2 or not isinstance(bound[0], int):
                _err("Chooser API returned an unexpected input binding: " + path)
                return
            count = len(bound[1])
            binding = {"parameter_index": bound[0], "property_chain": [_text(bound[1][i]) for i in range(min(count, 32))], "total_segments": count, "truncated": count > 32}
        columns.append({"index": column, "type": _text(lib.get_column_type(asset, column)), "input_type": _text(lib.get_column_input_type(asset, column)), "disabled": lib.is_column_disabled(asset, column), "binding": binding})
    rows = []
    for row in range(row_offset, row_end):
        cells = []
        for column in range(column_offset, column_end):
            value_type = lib.get_cell_value_type(asset, column, row)
            value = lib.get_cell_value(asset, column, row) if value_type else None
            cells.append({"column": column, "available": bool(value_type) and bool(value), "type": _text(value_type), "value": _text(value) if value is not None else None})
        result_type = lib.get_row_result_type(asset, row)
        rows.append({"index": row, "disabled": lib.is_row_disabled(asset, row), "result_type": _text(result_type), "result": _text(lib.get_row_result_property(asset, row, "")) if result_type else None, "cells": cells})
    result_class = lib.get_result_class(asset)
    _emit({
        "ok": True, "path": asset.get_path_name(), "class": asset.get_class().get_path_name(), "scope": "primary_rows",
        "signature": {"result_type": _text(lib.get_result_type(asset)), "result_class": _text(result_class.get_path_name()) if result_class is not None else None, "parameter_count": lib.get_num_parameters(asset)},
        "row_count": row_count, "column_count": column_count, "columns": columns, "rows": rows,
        "page": {
            "rows": {"offset": row_offset, "returned": len(rows), "next_offset": row_end if row_end < row_count else None},
            "columns": {"offset": column_offset, "returned": len(columns), "next_offset": column_end if column_end < column_count else None}
        }
    })
_inspect_chooser()
`;
}

// shortcut: native getters export one property before text clipping; use a native
// bounded exporter if unusually large cell/result properties become common.
export const chooserInspectDescriptor: PyToolDescriptor<typeof schema.shape> = {
  name: 'chooser_inspect',
  description: 'Inspect a UE5.9 Chooser table through its editor scripting API: signature, primary decision rows, columns, input bindings, result assets and cell values in Unreal text format. Requires the optional Chooser plugin. At most 20 rows × 8 columns per page; text is clipped at 512 characters with explicit flags. Empty cell text may mean empty or unavailable, not validation success. Use next_offset for each dimension; fallback and nested table contents are outside this view. USE_WHEN: inspecting animation or gameplay selection decisions. NOT_WHEN: modifying or evaluating the table.',
  cost: 'medium', returns: '{ok, path, class, scope, signature, row_count, column_count, rows[], columns[], page:{rows,columns}}; text values include truncated and empty_or_unavailable flags',
  schema: schema.shape, meta: readMeta, readOnly: true, buildScript, timeoutMs: 30_000,
  finish: async (_params, result) => {
    if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) {
      throw new Error(result && typeof result === 'object' && 'error' in result ? String(result.error) : 'Chooser inspection returned no result');
    }
    return result;
  },
};
