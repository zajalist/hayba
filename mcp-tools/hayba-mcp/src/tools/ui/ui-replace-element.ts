import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_asset'],
  when: 'replacing a widget with a different widget class while preserving its child subtree by default and optionally preserving its GUID and/or properties',
  not_when: 'removing a widget (use ui_remove_element) or reparenting (use ui_reparent_element)',
};

export const schema = z.object({
  widget_blueprint_path: z.string().min(1).describe('Full path of the target Widget Blueprint'),
  widget_name: z.string().min(1).describe('Name of the widget to replace'),
  new_class: z.string().min(1).describe('New widget class to replace with (short name or full class path)'),
  new_name: z
    .string()
    .min(1)
    .max(1023)
    .refine((name) => name.toLocaleLowerCase('en-US') !== 'none', 'must not be the reserved Unreal NAME_None value')
    .refine(
      (name) => ![...name].some((character) => `"' ,/.:|&!~\n\r\t@#(){}[]=;^%$\``.includes(character)),
      'must be a valid Unreal object name without spaces or reserved characters',
    )
    .optional()
    .describe('Valid Unreal object name for the replacement widget (defaults to original name)'),
  preserve_guid: z.boolean().optional().default(true).describe('Preserve the original widget GUID'),
  preserve_properties: z
    .boolean()
    .optional()
    .default(false)
    .describe('Preserve original widget properties on the replacement'),
  preserve_children: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'Preserve and reparent the original child subtree onto the replacement (default true). Set false only to explicitly delete the subtree.',
    ),
});

export const uiReplaceElementHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('ui_mutate_tree', {
    operation: 'replace',
    ...parsed.data,
  } as Record<string, unknown>);
  const reply = data as Record<string, unknown>;
  const childrenPreserved = reply.children_preserved;
  const descendantsPreserved = reply.descendants_preserved;
  if (
    reply.preserve_children !== parsed.data.preserve_children ||
    !Number.isSafeInteger(childrenPreserved) ||
    (childrenPreserved as number) < 0 ||
    !Number.isSafeInteger(descendantsPreserved) ||
    (descendantsPreserved as number) < (childrenPreserved as number) ||
    (!parsed.data.preserve_children && (childrenPreserved !== 0 || descendantsPreserved !== 0))
  ) {
    return {
      content: [
        {
          type: 'text',
          text: 'ui_replace_element: Unreal did not return trustworthy child-preservation evidence; treat the replacement as unverified and inspect the widget tree.',
        },
      ],
      isError: true,
    };
  }
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
