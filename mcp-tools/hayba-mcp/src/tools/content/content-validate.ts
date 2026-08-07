import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { validateContentSnapshot, type ContentSnapshot } from '../../validator/content/index.js';
import { STRICTNESS_MODES } from '../../validator/config.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: [],
  when: 'checking project content for memory and performance problems — oversized textures, wrong compression, meshes with no LODs',
  not_when: 'checking a UI screen (use ui_validate) or one specific asset (texture_get_info)',
};

export const schema = z.object({
  strictness: z
    .enum(STRICTNESS_MODES)
    .optional()
    .describe(
      'Override the configured asset strictness. relaxed = only the extreme; standard = normal budgets; strict = tight budgets plus hygiene notes.',
    ),
  top_n: z
    .number()
    .int()
    .optional()
    .describe(
      'How many of the heaviest assets to judge, per type. Default 25. Anything outside this window is NOT examined, and the response says so.',
    ),
  include: z
    .array(z.enum(['textures', 'meshes']))
    .optional()
    .describe('Which audits to run. Defaults to both.'),
  rule_ids: z.array(z.string()).optional().describe('Run only these rules, by id.'),
});

export const contentValidateHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const { strictness, top_n, include, rule_ids } = parsed.data;
  const want = include ?? ['textures', 'meshes'];

  // The engine measures, this judges. Each audit is a separate command, and a
  // type that was not requested stays absent from the snapshot so its rules are
  // reported as skipped rather than passing on empty data.
  const snapshot: ContentSnapshot = {};

  if (want.includes('textures')) {
    const t = (await executeCommand('texture_audit', { top_n } as Record<string, unknown>)) as {
      textures?: ContentSnapshot['textures'];
      scanned?: number;
    };
    snapshot.textures = t?.textures ?? [];
    snapshot.textures_scanned = t?.scanned;
  }

  if (want.includes('meshes')) {
    const m = (await executeCommand('mesh_audit', { top_n } as Record<string, unknown>)) as {
      meshes?: ContentSnapshot['meshes'];
      scanned?: number;
    };
    snapshot.meshes = m?.meshes ?? [];
    snapshot.meshes_scanned = m?.scanned;
  }

  const result = validateContentSnapshot(snapshot, { strictness, ruleIds: rule_ids });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
};
