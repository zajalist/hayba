import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { validateUiSnapshot, UI_PLATFORMS, type UiFinding, type UiSnapshot } from '../../validator/ui/index.js';
import { STRICTNESS_MODES } from '../../validator/config.js';
import { appendFinding } from '../../validator/history.js';

interface UiSnapshotPage extends UiSnapshot {
  total_widget_count?: number;
  matched_widget_count?: number;
  offset?: number;
  limit?: number;
  has_more?: boolean;
  next_offset?: number;
}

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
  const snapshot = await readCompleteSnapshot(widget_blueprint_path, screen_width, screen_height);

  const result = validateUiSnapshot(snapshot, { platform, strictness, ruleIds: rule_ids });

  // Surface the findings in the editor's Validation panel. That panel is
  // push-only from inside UE, so a rule judged here has no other way to reach
  // the window the user actually watches — without this it only ever existed
  // in a tool response.
  if (persist !== false && result.findings.length > 0) {
    try {
      await executeCommand('ui_report_findings', {
        findings: result.findings.map((f) => ({
          rule_id: f.ruleId,
          severity: f.severity,
          message: f.message,
          hint: f.hint,
          widget: f.widget,
        })),
        append: false,
      } as Record<string, unknown>);
    } catch {
      // An older plugin build has no ui_report_findings. The findings are still
      // returned to the caller and written to history, so a failed push must
      // not fail the validation run.
    }
  }

  // Persist to the shared history file as well, so findings survive an editor
  // restart and can be reviewed with validator_history.
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

/**
 * The native response builder deliberately caps arrays at 50 items. A validator that reads only
 * page one gives the most recently appended production HUD controls no QA at all, which is worse
 * than an explicit failure. Walk every page, reject a server that ignores pagination, and judge
 * one reconstructed tree so parent/child and overlap rules still see the complete layout.
 */
async function readCompleteSnapshot(
  widgetBlueprintPath: string,
  screenWidth?: number,
  screenHeight?: number,
): Promise<UiSnapshot> {
  const allWidgets: UiSnapshot['widgets'] = [];
  const seenNames = new Set<string>();
  let first: UiSnapshotPage | undefined;
  let offset = 0;

  for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
    const page = (await executeCommand('ui_layout_snapshot', {
      widget_blueprint_path: widgetBlueprintPath,
      screen_width: screenWidth,
      screen_height: screenHeight,
      offset,
      limit: 50,
    } as Record<string, unknown>)) as UiSnapshotPage;

    first ??= page;
    let added = 0;
    for (const widget of page.widgets ?? []) {
      if (seenNames.has(widget.name)) continue;
      seenNames.add(widget.name);
      allWidgets.push(widget);
      added += 1;
    }

    const expected = page.matched_widget_count ?? page.total_widget_count ?? page.widget_count;
    const hasMore = page.has_more ?? allWidgets.length < expected;
    if (!hasMore) {
      return {
        ...first,
        widget_count: allWidgets.length,
        widgets: allWidgets,
      };
    }

    const nextOffset = page.next_offset ?? offset + (page.widgets?.length ?? 0);
    if (added === 0 || !Number.isInteger(nextOffset) || nextOffset <= offset) {
      throw new Error(
        `ui_layout_snapshot did not advance pagination at offset ${offset}; refusing to validate an incomplete widget tree`,
      );
    }
    offset = nextOffset;
  }

  throw new Error('ui_layout_snapshot exceeded 100 pages; refusing to validate an incomplete widget tree');
}

function toContext(f: UiFinding, blueprintPath: string, platform: string): Record<string, unknown> {
  return {
    widget_blueprint_path: blueprintPath,
    platform,
    ...(f.widget ? { widget: f.widget } : {}),
    ...(f.data ?? {}),
  };
}
