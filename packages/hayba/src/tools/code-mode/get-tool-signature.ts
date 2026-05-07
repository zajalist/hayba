import type { ToolHandler } from '../hayba-bake-terrain.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'reading the JSON schema of a specific HaybaOS command before invoking it',
  not_when: 'you only need a list of command names — use list_tool_categories instead',
};

const SCHEMAS: Record<string, { params: Record<string, string>; returns: string; cost: 'low'|'medium'|'high' }> = {
  actor_spawn: {
    params: { class_path: 'string (required)', location: '[x,y,z] (optional)', rotation: '[p,y,r] (optional)', scale: '[x,y,z] (optional)', label: 'string (optional)' },
    returns: '{actor_id, label, class}',
    cost: 'medium',
  },
  actor_list: {
    params: { class_filter: 'string (optional, exact class name)', tag: 'string (optional)' },
    returns: '{actors:[{id,label,class,location}], count}',
    cost: 'low',
  },
  scene_export: {
    params: { mode: '"flat"|"relational"|"hierarchical"', window: '{min:[x,y,z], max:[x,y,z]} (optional)', max_items: 'int (default 200)' },
    returns: 'mode-specific shape',
    cost: 'medium',
  },
  editor_capture_viewport: {
    params: { width: 'int (default 1280)', height: 'int (default 720)' },
    returns: '{image_base64, width, height, camera}',
    cost: 'medium',
  },
  python_run: {
    params: { script: 'string (required)', allow_unsafe: 'bool (optional, overrides setting)' },
    returns: '{ok, tier, stdout, stderr}',
    cost: 'high',
  },
};

export const getToolSignatureHandler: ToolHandler = async (args) => {
  const command = typeof args.command === 'string' ? args.command : '';
  if (!command) {
    return { content: [{ type: 'text', text: 'Error: command parameter is required' }], isError: true };
  }
  const sig = SCHEMAS[command];
  if (!sig) {
    return { content: [{ type: 'text', text: JSON.stringify({ status: 'no_schema_available', command, hint: 'use list_tool_categories to discover commands' }) }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify({ command, ...sig }, null, 2) }] };
};
