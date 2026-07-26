import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { validateUiSnapshot, UI_PLATFORMS, type UiSnapshot } from '../../validator/ui/index.js';
import { STRICTNESS_MODES } from '../../validator/config.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: [],
  when: 'checking a Widget Blueprint against game-UI standards — text overflow, safe areas, target sizes, contrast, focus, performance',
  not_when: 'you only need the widget tree (use ui_query) or a single string measurement (use ui_measure_text)',
};

export const schema = z.object({
  widget_blueprint_path: z.string().min(1).describe('Full path of the Widget Blueprint to validate'),
  platform: z
    .enum(UI_PLATFORMS)
    .optional()
    .default('pc')
    .describe(
      'Which conventions to judge against. "console" applies TV safe areas and the 28px legibility floor; "mobile" applies 44px touch targets; "handheld" sits between them.',
    ),
  strictness: z
    .enum(STRICTNESS_MODES)
    .optional()
    .describe(
      'Override the configured UI strictness for this run. relaxed = only what is broken; standard = plus UI conventions; strict = plus house-style polish. Defaults to the validator setting.',
    ),
  screen_width: z.number().optional().describe('Resolution to evaluate at. Defaults to the blueprint design size.'),
  screen_height: z.number().optional().describe('Resolution to evaluate at. Defaults to the blueprint design size.'),
  rule_ids: z.array(z.string()).optional().describe('Run only these rules, by id.'),
});

export const uiValidateHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const { widget_blueprint_path, platform, strictness, screen_width, screen_height, rule_ids } = parsed.data;

  // The engine does the measuring (Slate prepass + font metrics); the rules
  // are judged here so they can be extended and configured without a plugin
  // rebuild.
  const snapshot = (await executeCommand('ui_layout_snapshot', {
    widget_blueprint_path,
    screen_width,
    screen_height,
  } as Record<string, unknown>)) as UiSnapshot;

  const result = validateUiSnapshot(snapshot, { platform, strictness, ruleIds: rule_ids });

  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
};
