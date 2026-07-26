import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { validateUiSnapshot, UI_PLATFORMS, type UiFinding, type UiSnapshot } from '../../validator/ui/index.js';
import { STRICTNESS_MODES } from '../../validator/config.js';
import { appendFinding } from '../../validator/history.js';

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
  persist: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'Write the findings to the validator history so they appear in the editor Validation panel. Set false for a read-only check that leaves no trace.',
    ),
});

export const uiValidateHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const { widget_blueprint_path, platform, strictness, screen_width, screen_height, rule_ids, persist } = parsed.data;

  // The engine does the measuring (Slate prepass + font metrics); the rules
  // are judged here so they can be extended and configured without a plugin
  // rebuild.
  const snapshot = (await executeCommand('ui_layout_snapshot', {
    widget_blueprint_path,
    screen_width,
    screen_height,
  } as Record<string, unknown>)) as UiSnapshot;

  const result = validateUiSnapshot(snapshot, { platform, strictness, ruleIds: rule_ids });

  // Persist to the shared history file. The editor's Validation panel reads
  // .scratch/validator-history.jsonl — findings that only come back in the tool
  // response never reach the surface the user actually watches.
  if (persist !== false && result.findings.length > 0) {
    const timestamp = new Date().toISOString();
    for (const f of result.findings) {
      await appendFinding({
        ruleId: f.ruleId,
        severity: f.severity,
        message: f.message,
        hint: f.hint,
        context: toContext(f, widget_blueprint_path, platform),
        // Distinct per finding so resolve/clear can address them individually;
        // the runner emits them in one pass, so a shared stamp would collide.
        timestamp: `${timestamp}#${f.ruleId}:${f.widget ?? '-'}`,
        toolName: 'ui_validate',
      });
    }
  }

  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
};

function toContext(f: UiFinding, blueprintPath: string, platform: string): Record<string, unknown> {
  return {
    widget_blueprint_path: blueprintPath,
    platform,
    ...(f.widget ? { widget: f.widget } : {}),
    ...(f.data ?? {}),
  };
}
