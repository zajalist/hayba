import type { ToolHandler } from '../hayba-bake-terrain.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { isToolDisabled } from '../disabled-tools-watcher.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'discovering what HaybaOS can do before drilling into specific commands',
  not_when: 'you already know the exact tool name',
};

// TODO(v1.1): wire to C++ meta_list_domains when the handler exists
const DOMAINS: ReadonlyArray<{ domain: string; command_count: number; commands: string[] }> = [
  { domain: 'actor', command_count: 14, commands: ['actor_spawn','actor_delete','actor_transform','actor_list','actor_get_properties','actor_set_properties','actor_tag','actor_snap_to_socket','actor_duplicate','actor_set_visibility','actor_get_components','actor_call_function','actor_batch_spawn','placement_validate'] },
  { domain: 'level', command_count: 8, commands: ['level_load','level_save','level_list','level_get_info','level_get_spatial_index','level_create','level_set_bookmark','level_goto_bookmark'] },
  { domain: 'scene', command_count: 3, commands: ['scene_export','scene_validate_physics','scene_get_actor_relations'] },
  { domain: 'editor', command_count: 10, commands: ['editor_start_pie','editor_stop_pie','editor_set_camera','editor_capture_viewport','editor_run_console_command','editor_get_output_log','editor_stream_log','editor_live_compile','editor_get_performance_stats','editor_set_viewport_mode'] },
  { domain: 'python', command_count: 1, commands: ['python_run'] },
  { domain: 'asset', command_count: 8, commands: ['asset_search','asset_get_info','asset_import','asset_duplicate','asset_delete','asset_get_references','asset_validate','asset_rename'] },
  { domain: 'blueprint', command_count: 11, commands: ['blueprint_create','blueprint_get_info','blueprint_add_component','blueprint_add_variable','blueprint_add_function','blueprint_add_node','blueprint_connect_nodes','blueprint_compile','blueprint_document','blueprint_add_event','blueprint_set_defaults'] },
  { domain: 'material', command_count: 8, commands: ['material_create','material_add_node','material_connect_nodes','material_create_instance','material_set_param','material_apply','material_list','material_get_info'] },
  { domain: 'foliage', command_count: 4, commands: ['foliage_add_instance','foliage_remove_instances','foliage_list_types','foliage_paint_at'] },
  { domain: 'spline', command_count: 5, commands: ['spline_create','spline_add_point','spline_set_point','spline_remove_point','spline_get_info'] },
  { domain: 'wp', command_count: 3, commands: ['wp_get_cells','wp_load_cell','wp_get_streaming_state'] },
  { domain: 'ism', command_count: 4, commands: ['ism_create_actor','ism_add_instance','ism_add_instances','ism_clear_instances'] },
  { domain: 'physics', command_count: 3, commands: ['physics_set_simulate','physics_set_collision_profile','physics_add_impulse'] },
  { domain: 'docs', command_count: 3, commands: ['docs_search','docs_lookup_class','docs_lookup_api'] },
  { domain: 'pcg', command_count: 9, commands: ['pcg_list_node_classes','pcg_get_node_details','pcg_list_assets','pcg_export_graph','pcg_create_graph','pcg_validate_graph','pcg_execute_graph','pcg_read_node_output','landscape_import'] },
  { domain: 'seq', command_count: 8, commands: ['seq_create','seq_add_track','seq_add_keyframe','seq_get_info','seq_play','seq_export','seq_add_camera_cut','seq_set_playback_range'] },
  { domain: 'anim', command_count: 5, commands: ['anim_blueprint_get_info','anim_blueprint_add_state','anim_blueprint_add_transition','anim_blueprint_set_condition','anim_blueprint_compile'] },
  { domain: 'niagara', command_count: 3, commands: ['niagara_list','niagara_spawn','niagara_set_param'] },
  { domain: 'audio', command_count: 3, commands: ['audio_play','audio_list','audio_set_volume'] },
  { domain: 'metasound', command_count: 6, commands: ['metasound_create','metasound_add_node','metasound_connect','metasound_set_input','metasound_compile','metasound_list'] },
  { domain: 'gas', command_count: 4, commands: ['gas_create_ability','gas_grant_ability','gas_create_effect','gas_apply_effect'] },
  { domain: 'bt', command_count: 4, commands: ['bt_get_info','bt_add_node','bt_connect','bt_compile'] },
  { domain: 'input', command_count: 3, commands: ['input_create_action','input_create_mapping','input_add_mapping'] },
  { domain: 'ui', command_count: 3, commands: ['ui_create_widget','ui_add_element','ui_query'] },
  { domain: 'net', command_count: 2, commands: ['net_debug','net_set_replication'] },
  { domain: 'mesh', command_count: 3, commands: ['mesh_get_info','mesh_set_lod','mesh_list'] },
  { domain: 'texture', command_count: 3, commands: ['texture_get_info','texture_set_compression','texture_list'] },
  { domain: 'data', command_count: 3, commands: ['data_create','data_get','data_set'] },
  { domain: 'project', command_count: 4, commands: ['project_get_info','project_get_settings','project_set_settings','project_list_plugins'] },
  { domain: 'build', command_count: 3, commands: ['build_project','build_cook','build_generate_project_files'] },
  { domain: 'test', command_count: 3, commands: ['test_list','test_run','test_get_log'] },
];

export const listToolCategoriesHandler: ToolHandler = async () => {
  // Filter out tools the user has disabled in the MCP panel. Drop categories
  // that end up empty so the agent doesn't see "actor: 0 commands" noise.
  const filtered = DOMAINS
    .map(d => ({
      domain: d.domain,
      commands: d.commands.filter(c => !isToolDisabled(c)),
    }))
    .filter(d => d.commands.length > 0)
    .map(d => ({ domain: d.domain, command_count: d.commands.length, commands: d.commands }));

  return {
    content: [{ type: 'text', text: JSON.stringify({
      domains: filtered,
      total_commands: filtered.reduce((n, d) => n + d.command_count, 0),
    }, null, 2) }],
  };
};
