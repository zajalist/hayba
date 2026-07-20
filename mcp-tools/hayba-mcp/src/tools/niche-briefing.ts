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
UMG / WIDGET BLUEPRINT TOOLSET (3 tools) — first-touch briefing
================================================================
Author designer-editable UI the real UMG way (font picker works, artists can
tweak) instead of hand-building the tree in C++. Param names mirror the C++
handler exactly.

  ui_create_widget   Create a Widget Blueprint asset (seeds a root CanvasPanel).
                     path + name (+ optional parent_class descending from UserWidget).
  ui_add_element     Add a widget to an existing BP tree. widget_blueprint_path +
                     child_class (Button/TextBlock/Image/CanvasPanel/…), optional
                     parent_widget_name (a panel), name, and slot_props
                     (x/y/w/h for canvas, fill/padding for boxes).
  ui_query           Read back the widget tree: per-widget name/class/slot/children.

Tip: pass parent_class="/Script/<Module>.<CppWidget>" to keep C++ logic while
setting fonts/brushes visually in the BP — this fixes the UFontFace preview-tile
bug (Slate needs a composite UFont, or a font assigned through the designer).
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
    content: [
      ...result.content,
      { type: 'text' as const, text: briefing },
    ],
  };
}
