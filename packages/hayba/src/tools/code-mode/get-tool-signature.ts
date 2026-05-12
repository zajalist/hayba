import type { ToolHandler } from '../hayba-bake-terrain.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'reading the JSON schema of a specific HaybaOS command before invoking it',
  not_when: 'you only need a list of command names — use list_tool_categories instead',
};

type Signature = { params: Record<string, string>; returns: string; cost: 'low'|'medium'|'high' };

const SCHEMAS: Record<string, Signature> = {
  // ── actor ──────────────────────────────────────────────────────────────────
  actor_spawn: {
    params: { class_path: 'string (required)', location: '[x,y,z] (optional)', rotation: '[p,y,r] (optional)', scale: '[x,y,z] (optional)', label: 'string (optional)' },
    returns: '{actor_id, label, class}',
    cost: 'medium',
  },
  actor_delete: {
    params: { actor_id: 'string (required)' },
    returns: '{ok, actor_id}',
    cost: 'low',
  },
  actor_transform: {
    params: { actor_id: 'string (required)', location: '[x,y,z] (optional)', rotation: '[p,y,r] (optional)', scale: '[x,y,z] (optional)' },
    returns: '{ok, actor_id, before, after}',
    cost: 'low',
  },
  actor_list: {
    params: { class_filter: 'string (optional, exact class name)', tag: 'string (optional)' },
    returns: '{actors:[{id,label,class,location}], count}',
    cost: 'low',
  },
  actor_get_properties: {
    params: { actor_id: 'string (required)', properties: 'string[] (optional, filter to these names)' },
    returns: '{actor_id, properties:{name→value}}',
    cost: 'low',
  },
  actor_set_properties: {
    params: { actor_id: 'string (required)', properties: 'object (name→value)' },
    returns: '{ok, actor_id, changed:[name]}',
    cost: 'medium',
  },
  actor_tag: {
    params: { actor_id: 'string (required)', tags: 'string[]', mode: '"add"|"set"|"remove" (default add)' },
    returns: '{ok, tags}',
    cost: 'low',
  },
  actor_duplicate: {
    params: { actor_id: 'string (required)', location: '[x,y,z] (optional offset)' },
    returns: '{new_actor_id}',
    cost: 'medium',
  },
  actor_set_visibility: {
    params: { actor_id: 'string (required)', visible: 'bool' },
    returns: '{ok}',
    cost: 'low',
  },
  actor_get_components: {
    params: { actor_id: 'string (required)' },
    returns: '{components:[{name,class}]}',
    cost: 'low',
  },
  actor_batch_spawn: {
    params: { items: '[{class_path, location?, rotation?, scale?, label?}]' },
    returns: '{spawned:[actor_id], count}',
    cost: 'high',
  },
  placement_validate: {
    params: { class_path: 'string', location: '[x,y,z]', rotation: '[p,y,r] (optional)' },
    returns: '{valid, reason?, collisions:[id]}',
    cost: 'medium',
  },

  // ── level ──────────────────────────────────────────────────────────────────
  level_load: {
    params: { path: 'string (required, UE asset path)' },
    returns: '{ok, level_name}',
    cost: 'high',
  },
  level_save: {
    params: { },
    returns: '{ok, dirty_packages:[name]}',
    cost: 'high',
  },
  level_list: {
    params: { },
    returns: '{levels:[{path,is_persistent}]}',
    cost: 'low',
  },
  level_get_info: {
    params: { },
    returns: '{name, path, actor_count, bounds:{min,max}}',
    cost: 'low',
  },
  level_get_spatial_index: {
    params: { window: '{min:[x,y,z], max:[x,y,z]} (optional)' },
    returns: '{cells:[{id,bounds,actor_count}]}',
    cost: 'medium',
  },

  // ── asset ──────────────────────────────────────────────────────────────────
  asset_search: {
    params: { query: 'string', class_filter: 'string (optional)', limit: 'int (default 50)' },
    returns: '{assets:[{path,name,class}]}',
    cost: 'low',
  },
  asset_get_info: {
    params: { asset_path: 'string (required)' },
    returns: '{path, class, size_kb, references_in, references_out}',
    cost: 'low',
  },
  asset_import: {
    params: { source_file: 'string (required)', dest_path: 'string (required, /Game/...)' },
    returns: '{ok, asset_path}',
    cost: 'high',
  },
  asset_get_references: {
    params: { asset_path: 'string (required)', mode: '"in"|"out"|"both" (default both)' },
    returns: '{referenced_by:[path], references:[path]}',
    cost: 'medium',
  },

  // ── blueprint ──────────────────────────────────────────────────────────────
  blueprint_create: {
    params: { name: 'string (required)', parent_class: 'string (default Actor)', path: 'string (UE folder)' },
    returns: '{ok, blueprint_path}',
    cost: 'medium',
  },
  blueprint_add_component: {
    params: { blueprint_path: 'string', component_class: 'string', name: 'string' },
    returns: '{ok, component_name}',
    cost: 'medium',
  },
  blueprint_add_variable: {
    params: { blueprint_path: 'string', name: 'string', type: 'string', default_value: 'any (optional)' },
    returns: '{ok}',
    cost: 'low',
  },
  blueprint_compile: {
    params: { blueprint_path: 'string' },
    returns: '{ok, warnings:[string], errors:[string]}',
    cost: 'medium',
  },

  // ── material ───────────────────────────────────────────────────────────────
  material_create: {
    params: { name: 'string', path: 'string (UE folder)', shading_model: 'string (optional)' },
    returns: '{ok, material_path}',
    cost: 'medium',
  },
  material_create_instance: {
    params: { parent_material: 'string', name: 'string', path: 'string' },
    returns: '{ok, instance_path}',
    cost: 'low',
  },
  material_set_param: {
    params: { material_path: 'string', param_name: 'string', value: 'any' },
    returns: '{ok}',
    cost: 'low',
  },
  material_apply: {
    params: { actor_id: 'string', slot_index: 'int (default 0)', material_path: 'string' },
    returns: '{ok}',
    cost: 'low',
  },

  // ── scene ──────────────────────────────────────────────────────────────────
  scene_export: {
    params: { mode: '"flat"|"relational"|"hierarchical"', window: '{min:[x,y,z], max:[x,y,z]} (optional)', max_items: 'int (default 200)' },
    returns: 'mode-specific shape',
    cost: 'medium',
  },
  scene_validate_physics: {
    params: { deep_check: 'bool (optional, routes to visual sidecar)', window: '{min:[x,y,z], max:[x,y,z]} (optional)' },
    returns: '{valid, floating:[{id,location}], interpenetrating:[{id_a,id_b}], checked_count, skipped_system_actors}',
    cost: 'medium',
  },
  scene_get_actor_relations: {
    params: { actor_id: 'string', max_neighbors: 'int (default 8)' },
    returns: '{actor_id, attached_parent?, attached_children:[id], spatial_neighbors:[{id,distance}]}',
    cost: 'low',
  },

  // ── editor ─────────────────────────────────────────────────────────────────
  editor_capture_viewport: {
    params: { width: 'int (default 1280)', height: 'int (default 720)' },
    returns: '{image_base64, width, height, camera}',
    cost: 'medium',
  },
  editor_start_pie: {
    params: { single_step: 'bool (optional)' },
    returns: '{ok, pie_world_id}',
    cost: 'high',
  },
  editor_stream_log: {
    params: { filter: 'string (optional substring)', since_line: 'int (default 0)' },
    returns: '{lines:[string], next_line:int}',
    cost: 'low',
  },
  editor_run_console_command: {
    params: { command: 'string' },
    returns: '{ok, output}',
    cost: 'medium',
  },

  // ── python ─────────────────────────────────────────────────────────────────
  python_run: {
    params: { script: 'string (required)', allow_unsafe: 'bool (optional, overrides setting)' },
    returns: '{ok, tier, stdout, stderr}',
    cost: 'high',
  },

  // ── pcg ────────────────────────────────────────────────────────────────────
  pcg_list_assets: {
    params: { path: 'string (default /Game/)' },
    returns: '{assets:[{name,path,nodeCount,edgeCount}], count}',
    cost: 'low',
  },
  pcg_export_graph: {
    params: { assetPath: 'string (required)' },
    returns: '{graph: {version,meta,nodes,edges,metadata}}',
    cost: 'medium',
  },
  pcg_create_graph: {
    params: { graph: 'JSON string (PCGEx graph)', name: 'string (asset name)' },
    returns: '{ok, asset_path}',
    cost: 'high',
  },
  pcg_validate_graph: {
    params: { graph: 'JSON string' },
    returns: '{valid, errors:[{type,node,pin,detail}], errorCount}',
    cost: 'medium',
  },
  pcg_execute_graph: {
    params: { assetPath: 'string' },
    returns: '{ok, generated_count, duration_ms}',
    cost: 'high',
  },
  landscape_import: {
    params: { heightmapPath: 'string', worldSizeKm: 'number (default 8)', maxHeightM: 'number (default 600)', landscapeMaterial: 'string (asset path or "")', actorLabel: 'string' },
    returns: '{ok, actor_id, components}',
    cost: 'high',
  },

  // ── foliage ────────────────────────────────────────────────────────────────
  foliage_paint_at: {
    params: { foliage_type: 'string', location: '[x,y,z]', radius: 'number', density: 'number (0..1)' },
    returns: '{ok, instances_added}',
    cost: 'medium',
  },
  foliage_list_types: {
    params: { },
    returns: '{types:[{name,path}]}',
    cost: 'low',
  },

  // ── docs ───────────────────────────────────────────────────────────────────
  docs_lookup_class: {
    params: { class_name: 'string' },
    returns: '{class, parent, description, properties:[{name,type,description}]}',
    cost: 'low',
  },
};

function suggestClose(name: string, all: string[]): string[] {
  // Lightweight Levenshtein-like score so an LLM that guessed a wrong name
  // still gets a "did you mean" hint instead of a dead end.
  const lname = name.toLowerCase();
  const scored = all.map(n => {
    const ln = n.toLowerCase();
    let score = 0;
    if (ln === lname) score = 100;
    else if (ln.startsWith(lname) || lname.startsWith(ln)) score = 80;
    else if (ln.includes(lname) || lname.includes(ln)) score = 60;
    else {
      // shared-prefix bonus
      let i = 0;
      while (i < ln.length && i < lname.length && ln[i] === lname[i]) i++;
      score = i * 4;
    }
    return { n, score };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, 3).filter(x => x.score > 0).map(x => x.n);
}

export const getToolSignatureHandler: ToolHandler = async (args) => {
  const command = typeof args.command === 'string' ? args.command : '';
  if (!command) {
    return { content: [{ type: 'text', text: 'Error: command parameter is required' }], isError: true };
  }
  const sig = SCHEMAS[command];
  if (!sig) {
    const did_you_mean = suggestClose(command, Object.keys(SCHEMAS));
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'no_schema_available',
          command,
          hint: 'use list_tool_categories to discover commands, or python_run to invoke via UE Python',
          did_you_mean,
        }, null, 2),
      }],
    };
  }
  return { content: [{ type: 'text', text: JSON.stringify({ command, ...sig }, null, 2) }] };
};
