// Asset-import-and-sources P0 tools, generated as UE Python via the pyTemplate
// factory (see py-tool-factory.ts). Sibling of actor/actor-py-tools.ts and
// editor/editor-py-tools.ts — same PyToolDescriptor shape, same _emit/_err
// envelope, same index.ts splice.
//
// Source of truth for the catalog: docs/plans/2026-06-28-mcp-supertooling-tools.json,
// domain "asset-import-and-sources" (P0s). We ship the python-feasible, NET-NEW
// subset and skip catalog entries that are C++-backed, TS-only, already
// surfaced by the legacy sidecar, or whose python is speculative:
//
//   SHIPPED (3): asset_create_folder, asset_open_editor,
//     asset_get_source_path.
//
//   SKIPPED:
//     - asset_import / asset_import_* → the actual FBX/texture/USD Interchange
//       importers are C++-backed and already surfaced by the legacy sidecar
//       (asset_import) plus the AssetConnectors sketchfab/polyhaven tools in
//       index.ts. python_run cannot drive Interchange task graphs reliably.
//     - asset_duplicate → present in the legacy sidecar (C++) AND in the
//       tool-executor NON_IDEMPOTENT set; a python near-dup would only add drift.
//     - asset_rename / asset_move / asset_fixup_redirectors → asset_rename is in
//       the sidecar; asset_move / asset_fix_redirectors / asset_get_dependencies
//       / asset_get_referencers are already reg()'d C++ tools in index.ts.
//     - asset_find → W2T1 already ships asset_registry_query
//       (class_filter/path_prefix/recursive/limit/offset). Rather than a
//       near-duplicate, this wave EXTENDS that tool with a name_contains
//       substring param (see editor-py-tools.ts). No separate asset_find.
//     - asset_exists → W2T1's object_exists already probes does_asset_exist FIRST
//       (then object path, then level-actor label). A registry-only asset_exists
//       would be a strict subset — folded into object_exists, not re-shipped.
//     - asset_validate → EditorValidatorSubsystem's python surface
//       (validate_assets / validate_loaded_asset) is inconsistent across 5.7
//       builds and would be guesswork; deferred to a live-validation / C++ pass
//       rather than shipped as speculative python.
//     - asset_dependency_report → overlaps asset_inspect (dep/ref counts) +
//       asset_get_dependencies/referencers (C++, full lists). No net-new value.
//
// OVERLAP notes (intentional, documented):
//   - asset_get_source_path vs the legacy asset_get_info: asset_get_source_path
//     reads ONLY the reimport source-file path(s) out of the asset's
//     AssetImportData (the "where did this come from on disk" question);
//     asset_get_info is the broad C++ single-asset info call.
//   - asset_save moved to native C++ (asset/asset-save.ts -> HaybaMCPAssetHandler::AssetSave).
//
// NON_IDEMPOTENT: none. asset_save (re-saving the same bytes = same state),
// asset_create_folder (make_directory is a no-op if it exists), asset_open_editor
// (pure UI focus) and asset_get_source_path (read) are all retry-safe — none
// creates or appends, so none is added to tool-executor's NON_IDEMPOTENT set.
//
// UNCERTAIN-API flags for the next live-validation pass (no try/with, native
// policy HCR-TIME-001: probes are hasattr-gated, anything else propagates):
//   - asset_get_source_path: the AssetImportData accessor varies by asset type
//     (get_first_filename / extract_filenames / source_data.source_files); all
//     shapes are probed, degrading to source_paths:[] when none is present.
//     Whether the class has asset_import_data at all is read from the
//     AssetImportData asset-registry tag (AssetData.get_tag_value).

import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { pyStr } from '../ue-python.js';
import type { PyToolDescriptor } from '../py-tool-factory.js';

const readMeta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'inspecting an asset\'s on-disk provenance before a reimport/repath',
  not_when: 'you need dependency/referencer graph — use asset_inspect / asset_get_dependencies',
};

const writeMeta: HaybaToolMeta = {
  cost: 'low',
  effects: ['writes-to-disk'],
  when: 'flushing dirty packages or creating a content folder before authoring assets there',
  not_when: 'creating/duplicating an asset — use the asset lifecycle tools',
};

const uiMeta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'surfacing an asset\'s editor tab for the user (pure UI focus)',
  not_when: 'reading asset state programmatically — use asset_inspect',
};

// ── asset_create_folder ─────────────────────────────────────────────────────────
export const assetCreateFolderSchema = z.object({
  path: z.string().min(1).describe('Content path of the folder to create, e.g. "/Game/Meshes/Rocks"'),
});
export type AssetCreateFolderParams = z.infer<typeof assetCreateFolderSchema>;

function assetCreateFolderScript(p: AssetCreateFolderParams): string {
  return [
    `_path = ${pyStr(p.path)}`,
    'existed = unreal.EditorAssetLibrary.does_directory_exist(_path)',
    'created = unreal.EditorAssetLibrary.make_directory(_path)',
    '_emit({"ok": True, "path": _path, "created": bool(created), "already_existed": bool(existed)})',
  ].join('\n');
}

export const assetCreateFolderDescriptor: PyToolDescriptor<typeof assetCreateFolderSchema.shape> = {
  name: 'asset_create_folder',
  description:
    'Create a Content Browser folder (make_directory). Idempotent: a no-op that reports already_existed:true when the folder is already present. Use before authoring/importing assets into a new path.',
  cost: 'low',
  returns: '{ok, path, created, already_existed}',
  schema: assetCreateFolderSchema.shape,
  meta: writeMeta,
  buildScript: assetCreateFolderScript,
  timeoutMs: 30_000,
};

// ── asset_open_editor ───────────────────────────────────────────────────────────
export const assetOpenEditorSchema = z.object({
  asset_paths: z.array(z.string().min(1)).min(1).describe('Content paths of assets whose editor tabs to open'),
});
export type AssetOpenEditorParams = z.infer<typeof assetOpenEditorSchema>;

function assetOpenEditorScript(p: AssetOpenEditorParams): string {
  return [
    `_paths = ${JSON.stringify(p.asset_paths)}`,
    // No try/with (native policy HCR-TIME-001): existence is checked, not caught.
    'objs = []; missing = []',
    'for pth in _paths:',
    '    o = unreal.EditorAssetLibrary.load_asset(pth) if unreal.EditorAssetLibrary.does_asset_exist(pth) else None',
    '    if o is not None: objs.append(o)',
    '    else: missing.append(pth)',
    'aes = unreal.get_editor_subsystem(unreal.AssetEditorSubsystem) if objs else None',
    'if not objs:',
    '    _err("no loadable assets to open")',
    'elif aes is None:',
    '    _err("AssetEditorSubsystem unavailable")',
    'else:',
    '    aes.open_editor_for_assets(objs)',
    '    _emit({"ok": True, "opened": True, "count": len(objs), "missing": missing})',
  ].join('\n');
}

export const assetOpenEditorDescriptor: PyToolDescriptor<typeof assetOpenEditorSchema.shape> = {
  name: 'asset_open_editor',
  description:
    'Open the asset editor tab(s) for one or more assets (AssetEditorSubsystem.open_editor_for_assets) — pure UI focus, surfaces the asset for the user. Reports which paths were missing.',
  cost: 'low',
  returns: '{ok, opened, count, missing[]}',
  schema: assetOpenEditorSchema.shape,
  meta: uiMeta,
  buildScript: assetOpenEditorScript,
  timeoutMs: 30_000,
};

// ── asset_get_source_path ───────────────────────────────────────────────────────
export const assetGetSourcePathSchema = z.object({
  asset_path: z.string().min(1).describe('Content path of the imported asset, e.g. "/Game/Meshes/SM_Rock"'),
});
export type AssetGetSourcePathParams = z.infer<typeof assetGetSourcePathSchema>;

function assetGetSourcePathScript(p: AssetGetSourcePathParams): string {
  return [
    `_path = ${pyStr(p.asset_path)}`,
    'obj = unreal.EditorAssetLibrary.load_asset(_path) if unreal.EditorAssetLibrary.does_asset_exist(_path) else None',
    'if obj is None:',
    '    _err("asset not found: %s" % _path)',
    'else:',
    // asset_import_data is editor-only (not a python attribute, so hasattr cannot see it) and
    // get_editor_property raises on classes without it; those classes publish no AssetImportData registry tag.
    '    has_aid = unreal.EditorAssetLibrary.find_asset_data(_path).get_tag_value("AssetImportData") is not None',
    '    aid = obj.get_editor_property("asset_import_data") if has_aid else None',
    '    sources = []',
    '    if aid is not None:',
    '        # Probe the several AssetImportData accessors seen across asset types.',
    '        if hasattr(aid, "get_first_filename"):',
    '            fn = aid.get_first_filename()',
    '            if fn: sources.append(str(fn))',
    '        if not sources and hasattr(aid, "extract_filenames"):',
    '            for f in aid.extract_filenames(): sources.append(str(f))',
    '        if not sources and hasattr(aid, "source_data"):',
    '            for sf in aid.source_data.source_files: sources.append(str(sf.relative_filename))',
    '    _emit({"ok": True, "asset_path": _path, "has_import_data": aid is not None,',
    '           "source_paths": sources, "count": len(sources)})',
  ].join('\n');
}

export const assetGetSourcePathDescriptor: PyToolDescriptor<typeof assetGetSourcePathSchema.shape> = {
  name: 'asset_get_source_path',
  description:
    'Read an imported asset\'s reimport source-file path(s) from its AssetImportData — the "where did this come from on disk" question, ahead of a reimport or a broken-source fixup. Probes get_first_filename / extract_filenames / source_data across asset types; returns source_paths:[] when the asset carries no import data (procedural/native assets).',
  cost: 'low',
  returns: '{ok, asset_path, has_import_data, source_paths[], count}',
  schema: assetGetSourcePathSchema.shape,
  meta: readMeta,
  readOnly: true,
  buildScript: assetGetSourcePathScript,
  timeoutMs: 30_000,
};

// ── Aggregate: all asset-domain PyToolDescriptors (spliced in index.ts) ─────────
export const assetPyDescriptors: PyToolDescriptor[] = [
  assetCreateFolderDescriptor,
  assetOpenEditorDescriptor,
  assetGetSourcePathDescriptor,
] as unknown as PyToolDescriptor[];

/** Asset-domain factory tools that are non-idempotent. None: save/create-folder
 *  are retry-safe (idempotent state), open-editor is UI, source-path is a read. */
export const ASSET_NON_IDEMPOTENT: readonly string[] = [];
