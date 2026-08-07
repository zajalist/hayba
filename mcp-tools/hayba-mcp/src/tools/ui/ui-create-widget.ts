import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
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

export const uiCreateWidgetHandler: ToolHandler = ueTool('ui_create_widget', schema);
