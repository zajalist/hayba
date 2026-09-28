import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_asset'],
  when: 'making a button do something when clicked — bind a widget event (Button OnClicked, OnHovered, OnPressed) to an event node in its Widget Blueprint, the Details panel "+" next to the event',
  not_when: 'binding a property such as Text or Visibility to a variable (use ui_bind_property), or adding a start-up event like Construct (use blueprint_add_event)',
};

export const schema = z.object({
  widget_blueprint_path: z.string().min(1).describe('Full path of the Widget Blueprint that owns the widget, e.g. /Game/UI/WBP_Title'),
  widget_name: z
    .string()
    .min(1)
    .describe('The widget whose event fires, e.g. "StartButton". It must be exposed as a variable first (ui_set_variable) and the blueprint compiled.'),
  event_name: z
    .string()
    .min(1)
    .describe('The event to bind — "OnClicked" for a click. A wrong name is refused with the list of events the widget has.'),
  graph_name: z.string().optional().describe('Event graph to place the node in; omit for the main one'),
  x: z.number().optional().describe('Node position in the graph'),
  y: z.number().optional().describe('Node position in the graph'),
});

/**
 * The wire command is generic — it binds component events as well as widget
 * events — so it names its params `path` and `target`. Passing the UI-shaped
 * names straight through would be read by nothing on the C++ side.
 */
export const uiBindEventHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const { widget_blueprint_path, widget_name, event_name, graph_name, x, y } = parsed.data;
  const wire: Record<string, unknown> = { path: widget_blueprint_path, target: widget_name, event_name };
  if (graph_name !== undefined) wire.graph_name = graph_name;
  if (x !== undefined) wire.x = x;
  if (y !== undefined) wire.y = y;
  const data = await executeCommand('blueprint_add_bound_event', wire);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
