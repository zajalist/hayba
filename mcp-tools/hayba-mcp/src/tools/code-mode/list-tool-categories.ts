import type { ToolHandler } from '../types.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { isToolDisabled } from '../disabled-tools-watcher.js';
import { listRecordedCommands } from '../schema-registry.js';
import { listAgentCallableLegacyCommands } from '../../legacy-commands/index.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'discovering what HaybaOS can do before drilling into specific commands',
  not_when: 'you already know the exact tool name',
};

// The plugin's capability surface, hand-maintained.
//
// This list used to be the WHOLE catalogue, and it had drifted badly: 176 of the
// 245 registered tools were absent from it, including every UI tool added after
// the first three. The tool an agent consults to learn what the system can do
// was understating it by 72%, and its own legend framed the omission as "does
// not exist" rather than "not listed here".
//
// It is no longer the source of truth for anything callable. The callable half
// is derived from the schema registry below, so it cannot drift. What stays here
// is the one thing the registry genuinely cannot know: commands the C++ plugin
// dispatches but no agent wrapper reaches yet. Those are worth naming — an agent
// that knows the capability exists can ask the user or reach for python_run
// instead of concluding it is impossible.
//
// A guard test asserts every registered tool appears in the generated output, so
// this file falling behind is a test failure rather than a silent lie.
const DOMAINS: ReadonlyArray<{ domain: string; command_count: number; commands: string[] }> = [
  { domain: 'actor', command_count: 14, commands: ['actor_spawn','actor_delete','actor_transform','actor_list','actor_get_properties','actor_set_properties','actor_tag','actor_snap_to_socket','actor_duplicate','actor_set_visibility','actor_get_components','actor_call_function','actor_batch_spawn','placement_validate'] },
  { domain: 'level', command_count: 8, commands: ['level_load','level_save','level_list','level_get_info','level_get_spatial_index','level_create','level_set_bookmark','level_goto_bookmark'] },
  { domain: 'scene', command_count: 3, commands: ['scene_export','scene_validate_physics','scene_get_actor_relations'] },
  { domain: 'editor', command_count: 10, commands: ['editor_start_pie','editor_stop_pie','editor_set_camera','editor_capture_viewport','editor_run_console_command','editor_get_output_log','editor_stream_log','editor_live_compile','editor_get_performance_stats','editor_set_viewport_mode'] },
  { domain: 'python', command_count: 1, commands: ['python_run'] },
  { domain: 'asset', command_count: 8, commands: ['asset_search','asset_get_info','asset_import','asset_duplicate','asset_delete','asset_get_references','asset_validate','asset_rename'] },
  // blueprint_add_node / blueprint_connect_nodes / blueprint_add_event are C++ stubs that
  // return not_implemented_in_v1 — they will never succeed. Omit them so the catalog
  // does not advertise commands an agent cannot use. (HaybaMCPBlueprintHandler.cpp:345/350/465)
  { domain: 'blueprint', command_count: 8, commands: ['blueprint_create','blueprint_get_info','blueprint_add_component','blueprint_add_variable','blueprint_add_function','blueprint_compile','blueprint_document','blueprint_set_defaults'] },
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
  { domain: 'build', command_count: 4, commands: ['build_project','build_cook','build_generate_project_files','build_status'] },
  { domain: 'test', command_count: 3, commands: ['test_list','test_run','test_get_log'] },
];

/** Domain for a command name. Mirrors inferDir() in ../index.ts, duplicated
 *  deliberately: index.ts imports this module, so importing it back would close
 *  a cycle. Falls back to the prefix before the first underscore, which is the
 *  convention every domain follows. */
function domainOf(name: string): string {
  if (name.startsWith('hayba_fab_')) return 'fab';
  if (name.startsWith('hayba_polyhaven_') || name.startsWith('hayba_ambientcg_') || name.startsWith('hayba_sketchfab_')) {
    return 'asset-sources';
  }
  if (name === 'list_tool_categories' || name === 'get_tool_signature') return 'code-mode';
  if (name.startsWith('hayba_')) {
    const rest = name.slice('hayba_'.length);
    const head = rest.split('_')[0];
    return head || 'hayba';
  }
  const head = name.split('_')[0];
  return head || 'misc';
}

/**
 * A command is *agent-callable right now* iff it has a TS wrapper in the schema
 * registry OR it is allow-listed for the ue_legacy route. The DOMAINS array
 * above is the plugin's full *capability* surface (what the C++ dispatch table
 * can do); this set is the much smaller surface an agent can actually reach via
 * hayba_invoke. Surfacing both — instead of advertising all 154 as equal — stops
 * the agent burning turns on unknown_tool/legacy_not_allowlisted. See the MCP UX
 * review (2026-06-18).
 */
function callableCommandSet(): ReadonlySet<string> {
  const set = new Set<string>(listRecordedCommands());
  for (const name of listAgentCallableLegacyCommands()) set.add(name);
  return set;
}

export const listToolCategoriesHandler: ToolHandler = async () => {
  const callable = callableCommandSet();

  // Everything callable, grouped by domain, straight from the registry. This is
  // the half that must never be stale, so it is never written down.
  const byDomain = new Map<string, { callable: string[]; unavailable: string[] }>();
  const bucket = (d: string) => {
    let b = byDomain.get(d);
    if (!b) { b = { callable: [], unavailable: [] }; byDomain.set(d, b); }
    return b;
  };

  for (const name of callable) {
    if (isToolDisabled(name)) continue;
    bucket(domainOf(name)).callable.push(name);
  }

  // Plugin commands with no wrapper. Anything here that HAS since gained a
  // wrapper is already in the callable set above, so skip it rather than
  // reporting the same command twice with contradictory availability.
  for (const d of DOMAINS) {
    for (const name of d.commands) {
      if (callable.has(name) || isToolDisabled(name)) continue;
      bucket(d.domain).unavailable.push(name);
    }
  }

  const domains = Array.from(byDomain.entries())
    .map(([domain, b]) => ({
      domain,
      command_count: b.callable.length + b.unavailable.length,
      callable_count: b.callable.length,
      callable: b.callable.slice().sort(),
      // Advertised by the plugin but not yet wrapped for agents — calling these
      // returns unknown_tool. Listed so the agent knows the capability exists
      // (e.g. to ask the user / use python_run) without trying to invoke them.
      unavailable: b.unavailable.slice().sort(),
    }))
    .filter(d => d.command_count > 0)
    .sort((a, b) => b.callable_count - a.callable_count || a.domain.localeCompare(b.domain));

  const totalAdvertised = domains.reduce((n, d) => n + d.command_count, 0);
  const totalCallable = domains.reduce((n, d) => n + d.callable_count, 0);

  return {
    content: [{ type: 'text', text: JSON.stringify({
      _legend: 'callable = invokable now via hayba_invoke, no pack load needed. unavailable = the plugin supports it but no agent wrapper exists yet (calling it errors). The callable list is generated from the live tool registry, so it reflects what is actually there.',
      domains,
      total_commands: totalAdvertised,
      total_callable: totalCallable,
    }, null, 2) }],
  };
};
