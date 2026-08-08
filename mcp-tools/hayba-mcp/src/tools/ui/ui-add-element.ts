import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_asset'],
  when: 'adding a widget (Button/TextBlock/Image/panels/…) to an existing Widget Blueprint tree',
  not_when: 'creating the Widget Blueprint itself (use ui_create_widget first)',
};

// slot_props keys x/y/w/h (canvas offsets), fill/padding (box slots) are handled
// explicitly by the C++ handler; any other key falls through to reflection on the
// slot object. Values are primitives (number/string/bool) — see HaybaMCPUIHandler.cpp.
export const schema = z.object({
  widget_blueprint_path: z
    .string()
    .min(1)
    .describe('Full path of the target Widget Blueprint, e.g. "/Game/Aphrosia/UI/WBP_StartScreen"'),
  child_class: z
    .string()
    .min(1)
    .describe(
      'Widget class to add — short name (Button, TextBlock, Image, CanvasPanel, HorizontalBox, VerticalBox, Overlay, ScrollBox, Border, GridPanel, UniformGridPanel, SizeBox, Spacer, CheckBox, EditableTextBox, ProgressBar, Slider) or a full class path.',
    ),
  parent_widget_name: z
    .string()
    .optional()
    .describe('Name of an existing PANEL widget to parent under. Defaults to the root panel; errors if the root is not a panel and none is given.'),
  name: z.string().optional().describe('Name for the new widget (auto-generated if omitted).'),
  slot_props: z
    .record(z.string(), z.union([z.number(), z.string(), z.boolean()]))
    .optional()
    .describe(
      'Slot layout props. Canvas slot: x, y, w, h (offsets). Box slot: fill, padding. Any other key is set on the slot by reflection.',
    ),
});

export const uiAddElementHandler: ToolHandler = ueTool('ui_add_element', schema);
