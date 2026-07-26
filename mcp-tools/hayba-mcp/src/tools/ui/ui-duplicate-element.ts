import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_asset'],
  when: 'copying an existing widget — with its children, properties and slot layout — to build repeated rows or cards',
  not_when:
    'you need this to be reliable right now — see the known issue below; ui_build_tree is the dependable way to produce a repeated structure',
};

// KNOWN ISSUE: this path is not fully settled. Cloning no longer corrupts the
// SOURCE widget's subtree (it used to rename the original's children out from
// under the blueprint), but the copy itself can still come back trashed or
// sharing a name with its source. The handler verifies the result and returns a
// hard error when that happens rather than reporting success, so a bad outcome
// is loud — but a call that errors is still a call that did not work.
//
// Prefer ui_build_tree when you need a repeated structure and cannot tolerate a
// retry. Diagnosis so far is in docs/HANDOFF-umg-validation.md.
export const schema = z.object({
  widget_blueprint_path: z.string().min(1).describe('Full path of the target Widget Blueprint'),
  widget_name: z.string().min(1).describe('Name of the widget to duplicate. Its whole subtree is copied.'),
  new_name: z.string().optional().describe('Name for the copy. Auto-uniquified from the source name if omitted.'),
  parent_widget_name: z
    .string()
    .optional()
    .describe('Panel to place the copy under. Defaults to the source widget own parent (i.e. a sibling copy).'),
  slot_props: z
    .record(z.union([z.number(), z.string(), z.boolean(), z.array(z.number())]))
    .optional()
    .describe('Slot layout overrides for the copy, applied after the source slot layout is cloned.'),
});

export const uiDuplicateElementHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('ui_mutate_tree', {
    operation: 'duplicate',
    ...parsed.data,
  } as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
