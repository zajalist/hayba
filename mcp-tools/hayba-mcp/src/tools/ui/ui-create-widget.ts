import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['creates_asset'],
  when: 'creating a new UMG Widget Blueprint asset (designer-editable UI) in the project',
  not_when: 'adding a widget to an EXISTING Widget Blueprint (use ui_add_element)',
};

export const schema = z.object({
  path: z
    .string()
    .min(1)
    .describe('UE content package directory for the new Widget Blueprint, e.g. "/Game/Aphrosia/UI"'),
  name: z.string().min(1).describe('Asset name for the new Widget Blueprint, e.g. "WBP_StartScreen"'),
  parent_class: z
    .string()
    .optional()
    .describe(
      'Parent class the widget derives from — MUST descend from UserWidget. A class path like "/Script/Aphrosia.StartScreenWidget" or "/Script/UMG.UserWidget", or a short name. Defaults to UserWidget.',
    ),
});

export const uiCreateWidgetHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('ui_create_widget', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
