import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { executeCommand } from '../tool-executor.js';
import type { ToolHandler } from '../types.js';

export const schema = z
  .object({
    include_dirty: z
      .boolean()
      .optional()
      .describe(
        'Walk every loaded package for dirty_packages (default true). false skips the walk; the reply then has dirty_packages_skipped:"include_dirty".',
      ),
  })
  .strict();

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'probing editor/world/asset state before an action loop (the gating + read half of inspect-then-edit)',
  not_when: 'you already hold a fresh read of the same state from a prior call',
};

/**
 * Native by design. This command is the safety gate used before PIE, saves,
 * and editor shutdown, so it must not depend on python_run or dynamic Python
 * reflection that the crash-policy scanner correctly refuses.
 * It also reports who owns PIE (none | user | agent:<owner>); poll it until pie is "none" after a pie_active refusal.
 */
export const editorGetStateHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  try {
    const data = await executeCommand<Record<string, unknown>>('editor_get_state', parsed.data);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `editor_get_state error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
};
