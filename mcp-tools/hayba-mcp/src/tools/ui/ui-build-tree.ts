import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_asset'],
  when: 'building a whole screen or subtree at once — the layout is known up front',
  not_when: 'adding a single widget to an existing tree (use ui_add_element)',
};

const propertyValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(propertyValue), z.record(propertyValue)]),
);

// Recursive by construction: a node's children are nodes. z.lazy is required
// because the schema refers to itself.
const nodeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    class: z
      .string()
      .min(1)
      .describe(
        'Widget class — short name ("VerticalBox", "TextBlock") or a full class path, including your own /Game/... widget blueprint classes',
      ),
    name: z.string().optional().describe('Name for this widget. Must be unique in the blueprint; auto-generated if omitted.'),
    properties: z.record(propertyValue).optional().describe('Properties set on the widget itself'),
    slot_props: z.record(propertyValue).optional().describe('Layout properties for this widget slot in its parent'),
    children: z.array(nodeSchema).optional().describe('Child nodes. Only valid when `class` is a panel widget.'),
  }),
);

export const schema = z.object({
  widget_blueprint_path: z.string().min(1).describe('Full path of the target Widget Blueprint'),
  parent_widget_name: z.string().optional().describe('Existing panel to build under. Defaults to the root panel.'),
  tree: z
    .union([nodeSchema, z.array(nodeSchema)])
    .describe(
      'A node, or an array of sibling nodes, each {class, name?, properties?, slot_props?, children?}. Built depth-first in order. On failure the widgets created before the failing node are KEPT and named in the error.',
    ),
});

export const uiBuildTreeHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('ui_build_tree', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
