// First-touch niche briefing: surfaces the full tool catalogue for a domain
// the first time any tool in that domain is called within a session.

import type { SessionManager, ToolResult } from './types.js';

export const NICHE_BRIEFINGS: Record<string, string> = {
  material: `
MATERIAL TOOLSET (17 tools) — first-touch briefing
====================================================
Workflow note: graph edits auto-save to disk and DEFER compilation; call
material_compile when the graph is complete to apply settings + get translator errors.

GRAPH CONSTRUCTION
  material_create              Create a new master material asset
  material_function_create     Create a new material function asset
  material_add_node            Add an expression node to a material/function graph
  material_set_node            Move or set properties on an existing graph node
  material_set_property        Set master-material settings (blend mode, domain, shading model, two-sided, opacity mask clip)
  material_delete_node         Remove a node from a material/function graph
  material_connect_nodes       Connect two nodes, or wire a node output to a material property
  material_disconnect          Break a connection — clear a node input or material output property
  material_add_comment         Add a titled comment box around a group of nodes
  material_add_reroute_declaration  Create a named-reroute declaration (source anchor)
  material_add_reroute_usage   Create a named-reroute usage bound to a declaration

COMPILATION & INSPECTION
  material_compile             Explicitly compile a material — apply staged settings + surface translator errors + report shader optimization stats (instruction counts, texture samples, samplers) with hints
  material_get_info            Inspect a material or material instance: properties, parameters, connected expressions
  material_list                List materials and material instances in the project or a specific path

INSTANCE LAYER
  material_create_instance     Create a material instance derived from a parent material
  material_set_param           Set a scalar, vector (rgba), or texture parameter on a material instance
  material_apply               Apply a material (or instance) to an actor in the level
`.trim(),

  ui: `
UMG / WIDGET BLUEPRINT TOOLSET (17 tools) — first-touch briefing
=================================================================
Widget Blueprint editing operates on the authoritative designer WidgetTree.
Changes survive compile, save, editor restart, and PIE.

PERSISTENCE INVARIANT (CRITICAL):
  ui_set_widget_properties and typed tools (ui_set_text_style etc.) call
  Modify()+PostEditChange()+MarkBlueprintAsModified but do NOT compile or save.
  Call ui_compile_widget to apply staged changes, then ui_save_widget to persist.

CREATION
  ui_create_widget     Create a new Widget Blueprint asset
  ui_add_element       Add a child widget to an existing BP tree

INSPECTION
  ui_query             Return the widget tree (name/class/slot/children)
  ui_get_widget_info   Extended query with properties + GUIDs
  ui_search_widgets    Find widgets by name pattern or class
  ui_list_widget_types List available UMG widget classes

PROPERTY EDITING (survive compile+save+restart)
  ui_set_widget_properties  Generic: set named properties + slot layout
  ui_set_property           Set a single property by name
  ui_set_text_style         Font, size, color, outline, shadow, justification
  ui_set_brush              Texture/material resource, tint, draw style
  ui_set_visibility         Visible/Hidden/Collapsed
  ui_set_slot_layout        Canvas anchors, position, size, alignment, Z-order

PERSISTENCE
  ui_compile_widget     Compile the BP; returns warnings/errors
  ui_save_widget        Save to disk; optionally compile first

STRUCTURAL
  ui_remove_element     Remove a widget from the tree
  ui_reparent_element   Move a widget to a new parent
  ui_replace_element    Swap a widget's class at the same position

After any edit: ui_compile_widget → ui_save_widget → ui_query with
include_properties=true to verify values survive.
`.trim(),
};

/**
 * If this is the first time `domain` is seen in `session`, appends a niche
 * briefing text item to `result.content` and returns the mutated result.
 * Returns `result` unchanged when:
 *   - session is undefined
 *   - domain has no registered briefing
 *   - the domain has already been briefed this session
 */
export function appendNicheBriefing(
  domain: string,
  session: SessionManager | undefined,
  result: ToolResult,
): ToolResult {
  if (!session?.briefNicheOnce) return result;
  const briefing = NICHE_BRIEFINGS[domain];
  if (!briefing) return result;
  if (!session.briefNicheOnce(domain)) return result;
  return {
    ...result,
    content: [...result.content, { type: 'text' as const, text: briefing }],
  };
}
