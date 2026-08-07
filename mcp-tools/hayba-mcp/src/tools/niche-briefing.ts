// First-touch niche briefing: surfaces the full tool catalogue for a domain
// the first time any tool in that domain is called within a session.

import type { RichToolResult, SessionManager, ToolResult } from './types.js';

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
UMG / WIDGET BLUEPRINT TOOLSET (26 tools) - first-touch briefing
=================================================================
Widget Blueprint editing operates on the authoritative designer WidgetTree.
Changes survive compile, save, editor restart, and PIE.

PERSISTENCE INVARIANT (CRITICAL):
  Every editing tool marks the blueprint modified but does NOT compile or save.
  Call ui_compile_widget to apply staged changes, then ui_save_widget to persist.
  ui_layout_snapshot / ui_validate need a COMPILED class - compile first or they
  report layout_resolved:false and skip every geometry rule.

CREATION
  ui_create_widget     Create a new Widget Blueprint asset
  ui_add_element       Add one child widget to an existing tree
  ui_build_tree        Build a whole subtree from one nested spec (prefer this
                       for a new screen - one call, not one per widget)
  ui_duplicate_element Clone a widget + its subtree, properties and slot layout

INSPECTION
  ui_query             Widget tree; name_pattern/class_filter/flatten for a
                       flat match list instead of the whole tree
  ui_get_widget_info   Extended query with properties + GUIDs
  ui_search_widgets    Find widgets by name substring or class
  ui_list_widget_types Native UMG classes (include_blueprints for your own)
  ui_list_widget_blueprints  Widget Blueprints in the project, with _C paths

PROPERTY EDITING
  ui_set_widget_properties  Generic: named properties + slot layout. Values may
                            be NESTED objects for struct properties.
  ui_set_property           One property by name
  ui_set_text_style         Font, size, color, outline, shadow, justification
  ui_set_brush              Resource, tint, draw style (brush_property:
                            "Brush" for Image, "Background" for Border)
  ui_set_visibility         Visible/Hidden/Collapsed/HitTestInvisible
  ui_set_slot_layout        Canvas anchors/position/size/z-order, box
                            padding/fill/alignment, grid row/column
  ui_set_variable           Expose a widget as a blueprint variable. Without
                            this the graph and C++ BindWidget cannot reach it.

STRUCTURAL
  ui_remove_element     Remove a widget and its whole subtree
  ui_reparent_element   Move to a different parent (optional index, slot_props)
  ui_move_element       Reorder among siblings (= draw and tab order)
  ui_rename_element     Rename, carrying the variable GUID across
  ui_replace_element    Swap class in place (preserve_guid, preserve_properties)

MEASUREMENT AND VALIDATION
  ui_layout_snapshot   Real Slate layout: every widget's resolved rectangle,
                       font, measured text width, brush facts
  ui_measure_text      Exact rendered width of a string, and how many characters
                       fit: the actual string, typical prose, and the worst case
                       if every glyph were the font's widest
  ui_validate          Run the UI rule catalogue - text overflow with the exact
                       character count, localisation headroom, TV safe areas,
                       touch targets, overlap, WCAG contrast, gamepad focus,
                       performance traps. Per platform (pc/console/handheld/
                       mobile) and per strictness (relaxed/standard/strict,
                       set with validator_strictness).

REPORTING CONTRACT
  Editing tools report per-key outcomes: succeeded, failed_properties,
  unknown_slot_props, warnings. A key the widget or slot did not accept comes
  back named - it is never silently dropped.
  ui_validate reports rules_skipped_no_layout separately from findings: a
  geometry rule with no geometry has checked NOTHING, and is never counted
  as a pass.

FONTS
  Assign a composite UFont, never a UFontFace. Slate renders a raw font face as
  its glyph-preview tiles instead of as text. Both the property setter and
  ui_validate flag this.

Suggested loop: ui_build_tree -> ui_compile_widget -> ui_validate -> fix ->
ui_compile_widget -> ui_save_widget.
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
export function appendNicheBriefing<T extends RichToolResult>(
  domain: string,
  session: SessionManager | undefined,
  result: T,
): T {
  if (!session?.briefNicheOnce) return result;
  const briefing = NICHE_BRIEFINGS[domain];
  if (!briefing) return result;
  if (!session.briefNicheOnce(domain)) return result;
  return {
    ...result,
    content: [...result.content, { type: 'text' as const, text: briefing }],
  };
}
