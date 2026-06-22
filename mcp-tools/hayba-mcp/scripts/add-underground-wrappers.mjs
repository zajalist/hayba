// One-shot sidecar augmentation: expose the already-implemented C++ handler
// commands (ISM / Spline / Blueprint / DataAsset / Level / Asset / Actor props /
// Editor extras / SceneGraph) to agents via hayba_invoke's ue_legacy route.
//
// These handlers are registered in HaybaMCPModule.cpp and present in the loaded
// plugin binary (verified: DLL newer than handler sources). The ONLY reason they
// were unreachable is that sidecar.json — the single allowlist source of truth —
// had no entry for them. We add agent_callable:true entries with params mirrored
// from each handler's TryGet*Field reads.
//
// CPD (ism_set_custom_data + num_custom_data_floats) is intentionally NOT added:
// it needs a C++ change + plugin rebuild. Greybox uses default materials, so
// per-instance custom data has no visible effect yet — deferred to production.
//
// Run from mcp-tools/hayba-mcp:  node scripts/add-underground-wrappers.mjs
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';

const SRC = 'src/legacy-commands/sidecar.json';
const DIST = 'dist/legacy-commands/sidecar.json';

const s = (name, required = true, type = 'string', description = '') => ({ name, type, required, ...(description ? { description } : {}) });

// handler_cpp points at the dispatch entry (FHaybaMCP*Handler::Handle); the
// per-command function is selected inside Handle by command string.
const E = (handler, params, returnsFields = [], notes = '') => ({
  aliases: [],
  handler_cpp: handler,
  params,
  returns: { shape: 'object', fields: returnsFields },
  agent_callable: true,
  has_ts_wrapper: false,
  notes,
});

const A = 'FHaybaMCPActorHandler::Handle';
const SP = 'FHaybaMCPSplineHandler::Handle';
const I = 'FHaybaMCPISMHandler::Handle';
const B = 'FHaybaMCPBlueprintHandler::Handle';
const D = 'FHaybaMCPDataAssetHandler::Handle';
const L = 'FHaybaMCPLevelHandler::Handle';
const AS = 'FHaybaMCPAssetHandler::Handle';
const ED = 'FHaybaMCPEditorHandler::Handle';
const SC = 'FHaybaMCPSceneGraphHandler::Handle';

const additions = {
  // ---- Actor (props / components / function / batch) ----
  actor_get_properties: E(A, [s('actor_id')], [{ name: 'properties', type: 'object' }], 'Reflect all properties on an actor.'),
  actor_set_properties: E(A, [s('actor_id'), s('properties', true, 'object', 'name->value map; structs/enums/vectors supported')], [], 'Set actor properties from a name->value map.'),
  actor_get_components: E(A, [s('actor_id'), s('include_internal', false, 'boolean')], [{ name: 'components', type: 'array' }]),
  actor_call_function: E(A, [s('actor_id'), s('function_name'), s('args', false, 'object')], [{ name: 'called', type: 'boolean' }], 'Call a BlueprintCallable UFunction on the actor.'),
  actor_duplicate: E(A, [s('actor_id'), s('location', false, 'array'), s('rotation', false, 'array'), s('scale', false, 'array'), s('label', false, 'string')], [{ name: 'id', type: 'string' }]),
  actor_tag: E(A, [s('actor_id'), s('add', false, 'array'), s('remove', false, 'array')]),
  actor_set_visibility: E(A, [s('actor_id'), s('visible', true, 'boolean')]),
  actor_snap_to_socket: E(A, [s('actor_id'), s('target_actor_id'), s('socket_name')]),
  actor_batch_spawn: E(A, [s('actors', true, 'array', 'array of {class_path, location?, rotation?, scale?, label?}')], [{ name: 'actors', type: 'array' }]),

  // ---- Spline ----
  spline_create: E(SP, [s('label'), s('location', false, 'array')], [{ name: 'actor_id', type: 'string' }, { name: 'label', type: 'string' }]),
  spline_add_point: E(SP, [s('actor_id'), s('location', true, 'array'), s('index', false, 'integer')], [{ name: 'point_count', type: 'number' }]),
  spline_set_point: E(SP, [s('actor_id'), s('index', true, 'integer'), s('location', true, 'array')], [{ name: 'updated', type: 'boolean' }]),
  spline_remove_point: E(SP, [s('actor_id'), s('index', true, 'integer')], [{ name: 'point_count', type: 'number' }]),
  spline_get_info: E(SP, [s('actor_id')], [{ name: 'point_count', type: 'number' }, { name: 'length', type: 'number' }, { name: 'points', type: 'array' }]),

  // ---- ISM ----
  ism_create_actor: E(I, [s('static_mesh_path'), s('label'), s('location', false, 'array')], [{ name: 'actor_id', type: 'string' }, { name: 'label', type: 'string' }], 'Spawns an actor whose root is an ISM component named "ISM".'),
  ism_add_instance: E(I, [s('actor_id'), s('transform', true, 'object', '{location?:[x,y,z], rotation?:[pitch,yaw,roll], scale?:[x,y,z]}')], [{ name: 'instance_index', type: 'number' }, { name: 'total_count', type: 'number' }]),
  ism_add_instances: E(I, [s('actor_id'), s('transforms', true, 'array', 'array of transform objects (cap 1000)')], [{ name: 'added', type: 'number' }, { name: 'total_count', type: 'number' }]),
  ism_clear_instances: E(I, [s('actor_id')], [{ name: 'cleared', type: 'boolean' }]),

  // ---- Blueprint ----
  blueprint_create: E(B, [s('name'), s('package_path'), s('parent_class_path')], [{ name: 'path', type: 'string' }]),
  blueprint_get_info: E(B, [s('path')], [{ name: 'components', type: 'array' }]),
  blueprint_add_component: E(B, [s('path'), s('component_class_path'), s('component_name')]),
  blueprint_add_variable: E(B, [s('path'), s('variable_name'), s('variable_type', true, 'string', 'bool/int/float/string/name/vector or a class/struct path')]),
  blueprint_compile: E(B, [s('path')], [{ name: 'compiled', type: 'boolean' }, { name: 'errors', type: 'array' }]),
  blueprint_set_defaults: E(B, [s('path'), s('properties', true, 'object')]),

  // ---- DataAsset ----
  data_create: E(D, [s('path'), s('name'), s('class_name', true, 'string', 'must inherit UDataAsset')], [{ name: 'path', type: 'string' }]),
  data_get: E(D, [s('path')], [{ name: 'properties', type: 'object' }]),
  data_set: E(D, [s('path'), s('property_name'), s('value', true, 'any')], [{ name: 'ok', type: 'boolean' }]),

  // ---- Level ----
  level_create: E(L, [s('name'), s('path', false, 'string')], [{ name: 'created', type: 'boolean' }]),
  level_save: E(L, [s('path', false, 'string')], [{ name: 'saved', type: 'boolean' }]),
  level_load: E(L, [s('path')], [{ name: 'loaded', type: 'boolean' }]),
  level_list: E(L, [], [{ name: 'levels', type: 'array' }]),
  level_get_info: E(L, [], [{ name: 'map_name', type: 'string' }, { name: 'actor_count', type: 'number' }]),

  // ---- Asset (kit migration) ----
  asset_search: E(AS, [s('path', false), s('name_filter', false), s('class_filter', false), s('include_thumbnails', false, 'boolean'), s('thumbnail_size', false, 'integer')], [{ name: 'assets', type: 'array' }]),
  asset_get_info: E(AS, [s('path'), s('include_thumbnails', false, 'boolean'), s('thumbnail_size', false, 'integer')]),
  asset_import: E(AS, [s('source_file'), s('destination_path')], [{ name: 'path', type: 'string' }]),
  asset_duplicate: E(AS, [s('source_path'), s('destination_path')], [{ name: 'path', type: 'string' }]),

  // ---- Editor extras (deterministic capture + diagnostics) ----
  editor_set_camera: E(ED, [s('location', false, 'array'), s('rotation', false, 'array')], [], 'Position the editor viewport camera for deterministic captures.'),
  editor_run_console_command: E(ED, [s('command')], [], 'Run an editor console command (stat unit, r.* toggles, etc).'),
  editor_get_output_log: E(ED, [s('lines', false, 'integer'), s('since_line', false, 'integer'), s('severity_filter', false, 'string'), s('regex_filter', false, 'string')], [{ name: 'lines', type: 'array' }]),
  editor_stop_pie: E(ED, [], [{ name: 'is_pie_running', type: 'boolean' }]),

  // ---- SceneGraph ----
  scene_get_actor_relations: E(SC, [s('actor_id', false)], [{ name: 'relations', type: 'array' }]),
};

const json = JSON.parse(readFileSync(SRC, 'utf-8'));
let added = 0, skipped = 0;
for (const [name, entry] of Object.entries(additions)) {
  if (json.commands[name]) { skipped++; continue; }
  json.commands[name] = entry;
  added++;
}
json.version = (json.version ?? 1); // keep schema version
const out = JSON.stringify(json, null, 2) + '\n';
writeFileSync(SRC, out);
if (existsSync('dist/legacy-commands')) { copyFileSync(SRC, DIST); }
console.error(`[add-underground-wrappers] added=${added} skipped=${skipped} total=${Object.keys(json.commands).length}`);
console.error(`[add-underground-wrappers] wrote ${SRC}${existsSync(DIST) ? ' + ' + DIST : ' (dist not present — run build:assets)'}`);
