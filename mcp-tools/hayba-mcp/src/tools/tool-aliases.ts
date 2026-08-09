// Single source of truth for which historical/expected param spellings a
// tool accepts, keyed by tool (command) name. Consumed by:
//   - hayba_invoke (src/tools/routing/meta-tools/invoke.ts) — the default
//     dispatch path under Code Mode / deferred routing.
//   - ueTool / PyToolDescriptor handlers — the direct-call path (also what
//     unit tests exercise).
//   - the two hand-registered meta-tools (get_tool_signature, python_run)
//     that sit outside both of the above.
//
// One map, one place to add a tool. See param-aliases.ts for the
// normalisation logic itself and docs/adr/0007 for why a second copy of this
// data would be the bug.
//
// GitHub issue #339 — table of confirmed round-trip failures plus the same
// shape found elsewhere in the same families.
import type { AliasMap } from './param-aliases.js';

export const TOOL_ALIASES: Record<string, AliasMap> = {
  ui_query: {
    path: ['widget_blueprint_path'],
  },
  ui_add_element: {
    child_class: ['widget_class'],
    name: ['child_name', 'widget_name'],
    parent_widget_name: ['parent_name'],
  },
  ui_reparent_element: {
    new_parent_name: ['new_parent_widget_name'],
  },
  ui_move_element: {
    index: ['new_index'],
  },
  get_tool_signature: {
    command: ['name'],
  },
  asset_delete: {
    paths: ['asset_paths'],
  },
  blueprint_create: {
    package_path: ['path'],
    parent_class_path: ['parent_class'],
  },
  // The C++ "seq_create" command is dormant (no sidecar entry, unreachable —
  // see sequencer-py-tools.ts); seq_new is the live tool that fills the same
  // role and has the same path/package_path confusion the issue described.
  seq_new: {
    path: ['package_path'],
  },
  python_run: {
    script: ['code'],
  },
};
