import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { executeCommand } from '../tool-executor.js';
import type { ToolHandler } from '../types.js';

export const schema = z.object({});

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
