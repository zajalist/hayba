/**
 * Static inventory for every `*-py-tools.ts` descriptor.
 *
 * This is deliberately explicit: adding a generated-Python descriptor makes the
 * drift test fail until its work sources have been reviewed. `bounded-in-scope`
 * means caller-controlled amplification is capped before UE transport; it does
 * not claim that arbitrary UE object graphs or native engine work are isolated.
 */
export const GENERATED_PYTHON_DESCRIPTOR_NAMES_BY_DOMAIN = {
  actor: [
    'actor_inspect',
    'actor_find',
    'actor_get_selection',
    'actor_set_selection',
    'actor_spawn_from_asset',
    'actor_batch_transform',
    'actor_focus',
    'actor_set_folder',
  ],
  asset: ['asset_save', 'asset_create_folder', 'asset_open_editor', 'asset_get_source_path'],
  editor: [
    'editor_get_camera',
    'editor_cvar_get',
    'editor_cvar_set',
    'selection_get',
    'asset_inspect',
    'outliner_tree',
    'object_inspect',
    'object_exists',
    'content_browser_sync',
    'reflect_search_types',
    'reflect_class',
  ],
  foliage: [
    'foliage_capability_probe',
    'foliage_scan_types',
    'foliage_type_inspect',
    'foliage_get_instance_count',
    'foliage_type_set_params',
    'foliage_replace_mesh',
    'foliage_type_create',
    'foliage_add_instances',
    'foliage_scatter_paint',
    'foliage_remove_in_bounds',
    'foliage_clear_type',
  ],
  landscape: [
    'landscape_list',
    'landscape_inspect',
    'landscape_layer_list',
    'landscape_get_material',
    'landscape_list_splines',
    'landscape_set_material',
    'landscape_set_lod_settings',
    'landscape_set_nanite',
    'landscape_add_layer',
  ],
  introspect: ['hayba_introspect'],
  lighting: [
    'lighting_capability_probe',
    'light_list',
    'light_get',
    'light_set',
    'postprocess_list_volumes',
    'postprocess_get',
    'postprocess_set',
    'exposure_set',
    'lumen_configure',
    'color_grading_set',
    'fog_configure',
    'light_spawn',
    'postprocess_spawn_volume',
    'sky_setup',
  ],
  mesh: ['mesh_get_sockets', 'mesh_get_lods', 'mesh_get_materials', 'mesh_get_bounds', 'mesh_set_material_slot'],
  niagara: [
    'niagara_capability_probe',
    'niagara_systems',
    'niagara_system_inspect',
    'niagara_param_list',
    'niagara_spawn_transient',
    'niagara_place_actor',
    'niagara_param_set',
    'niagara_set_user_param_default',
    'niagara_component_inspect',
    'niagara_list_components',
    'niagara_activate',
    'niagara_advance_simulation',
    'niagara_validate',
    'niagara_create_from_template',
  ],
  pcg: [
    'pcg_add_node',
    'pcg_set_prop',
    'pcg_wire',
    'pcg_inspect_instances',
    'pcg_remove_node',
    'pcg_disconnect',
    'pcg_layout',
    'pcg_list_pins',
    'pcg_get_node',
  ],
  sequencer: [
    'seq_new',
    'seq_inspect',
    'seq_bind_actor',
    'seq_track_add',
    'seq_transform_keyframe',
    'seq_camera_cut',
    'seq_playback_range',
    'seq_open',
    'seq_validate',
    'seq_list',
    'seq_list_bindings',
  ],
  water: [
    'water_check_plugin',
    'water_body_list',
    'water_body_inspect',
    'water_body_ocean_create',
    'water_body_lake_create',
    'water_body_river_create',
    'water_waves_inspect',
    'water_waves_set_gerstner',
    'water_zone_create',
    'water_zone_inspect',
    'water_validate',
  ],
} as const;

/** Caller values are multiplied into a loop/native work count. */
export const CALLER_FORMULA_DESCRIPTORS = new Set<string>(['foliage_scatter_paint', 'niagara_advance_simulation']);

/** Caller collections/objects drive Python iteration, materialization, or native calls. */
export const OPEN_CALLER_COLLECTION_DESCRIPTORS = new Set<string>([
  'actor_set_selection',
  'actor_batch_transform',
  'actor_set_folder',
  'asset_save',
  'asset_open_editor',
  'content_browser_sync',
  'foliage_add_instances',
  'niagara_param_set',
  'niagara_set_user_param_default',
  'pcg_set_prop',
  'water_body_river_create',
]);

/** Caller numeric values can amplify native allocation, geometry, or simulation work. */
export const OPEN_CALLER_NUMERIC_DESCRIPTORS = new Set<string>([
  'water_body_ocean_create',
  'water_body_lake_create',
  'water_body_river_create',
  'water_waves_set_gerstner',
  'water_zone_create',
]);

/**
 * Work/output depends on project, scene, selection, reflection, asset, component,
 * track, or instance cardinality. These are not fixed by the two #413 formula
 * guards and remain explicit follow-up work rather than being declared safe.
 */
export const OPEN_ENGINE_COLLECTION_DESCRIPTORS = new Set<string>([
  'actor_inspect',
  'actor_find',
  'actor_get_selection',
  'actor_set_selection',
  'actor_batch_transform',
  'actor_focus',
  'actor_set_folder',
  'asset_save',
  'asset_get_source_path',
  'selection_get',
  'asset_inspect',
  'outliner_tree',
  'object_inspect',
  'object_exists',
  'reflect_search_types',
  'reflect_class',
  'hayba_introspect',
  'foliage_capability_probe',
  'foliage_scan_types',
  'foliage_type_inspect',
  'foliage_get_instance_count',
  'foliage_add_instances',
  'foliage_scatter_paint',
  'foliage_remove_in_bounds',
  'foliage_clear_type',
  'landscape_list',
  'landscape_inspect',
  'landscape_layer_list',
  'landscape_get_material',
  'landscape_list_splines',
  'landscape_set_material',
  'landscape_set_lod_settings',
  'landscape_set_nanite',
  'lighting_capability_probe',
  'light_list',
  'light_get',
  'light_set',
  'postprocess_list_volumes',
  'postprocess_get',
  'postprocess_set',
  'exposure_set',
  'lumen_configure',
  'color_grading_set',
  'fog_configure',
  'mesh_get_sockets',
  'mesh_get_lods',
  'mesh_get_materials',
  'mesh_set_material_slot',
  'niagara_systems',
  'niagara_system_inspect',
  'niagara_param_list',
  'niagara_param_set',
  'niagara_set_user_param_default',
  'niagara_component_inspect',
  'niagara_list_components',
  'niagara_activate',
  'niagara_advance_simulation',
  'niagara_validate',
  'pcg_add_node',
  'pcg_set_prop',
  'pcg_wire',
  'pcg_inspect_instances',
  'pcg_remove_node',
  'pcg_disconnect',
  'pcg_layout',
  'pcg_list_pins',
  'pcg_get_node',
  'seq_inspect',
  'seq_bind_actor',
  'seq_track_add',
  'seq_transform_keyframe',
  'seq_camera_cut',
  'seq_validate',
  'seq_list',
  'seq_list_bindings',
  'water_check_plugin',
  'water_body_list',
  'water_body_inspect',
  'water_body_ocean_create',
  'water_body_lake_create',
  'water_body_river_create',
  'water_waves_inspect',
  'water_waves_set_gerstner',
  'water_zone_inspect',
  'water_validate',
]);

export type GeneratedPythonWorkStatus = 'bounded-in-scope' | 'fixed-caller-work' | 'follow-up-open';

export interface GeneratedPythonWorkInventoryItem {
  name: string;
  domain: keyof typeof GENERATED_PYTHON_DESCRIPTOR_NAMES_BY_DOMAIN;
  callerFormula: boolean;
  callerCollection: boolean;
  callerNumeric: boolean;
  engineCollection: boolean;
  status: GeneratedPythonWorkStatus;
  rationale: string;
}

const inventoryItems: GeneratedPythonWorkInventoryItem[] = [];
for (const [domain, names] of Object.entries(GENERATED_PYTHON_DESCRIPTOR_NAMES_BY_DOMAIN)) {
  for (const name of names) {
    const callerFormula = CALLER_FORMULA_DESCRIPTORS.has(name);
    const callerCollection = OPEN_CALLER_COLLECTION_DESCRIPTORS.has(name);
    const callerNumeric = OPEN_CALLER_NUMERIC_DESCRIPTORS.has(name);
    const engineCollection = OPEN_ENGINE_COLLECTION_DESCRIPTORS.has(name);
    const status: GeneratedPythonWorkStatus = callerFormula
      ? 'bounded-in-scope'
      : callerCollection || callerNumeric || engineCollection
        ? 'follow-up-open'
        : 'fixed-caller-work';
    const rationales: string[] = [];
    if (callerFormula) {
      rationales.push(
        'Caller-derived work formula reviewed; the exact count is precomputed and capped before UE transport.',
      );
    }
    if (callerCollection) {
      rationales.push(
        'Caller collection cardinality drives Python/native work and still needs a descriptor-specific cap.',
      );
    }
    if (callerNumeric) {
      rationales.push(
        'Caller numeric values can amplify native allocation, geometry, or simulation work and still need explicit finite/range/work caps.',
      );
    }
    if (engineCollection) {
      rationales.push(
        'Project/editor cardinality can still amplify collection or native work and remains explicit follow-up.',
      );
    }
    if (rationales.length === 0) {
      rationales.push(
        'No caller-controlled collection or numeric formula multiplies Python/native work; calls are structurally fixed for this review.',
      );
    }
    inventoryItems.push({
      name,
      domain: domain as GeneratedPythonWorkInventoryItem['domain'],
      callerFormula,
      callerCollection,
      callerNumeric,
      engineCollection,
      status,
      rationale: rationales.join(' '),
    });
  }
}

export const GENERATED_PYTHON_WORK_INVENTORY = Object.freeze(inventoryItems);
