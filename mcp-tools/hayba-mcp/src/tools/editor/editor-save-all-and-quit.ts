import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import { errorResult } from '../tool-result.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'high',
  effects: ['writes-to-disk'],
  when: 'ending an editor session — save every unsaved package and shut the editor down in one step',
  not_when: 'you only want to save one known package (asset_save)',
};

export const schema = z.object({
  quit: z
    .boolean()
    .optional()
    .default(true)
    .describe('Set false to save and verify every dirty package without shutting down.'),
});

interface SaveQuitResult {
  dirty_package_count_before: number;
  dirty_package_count_after: number;
  save_candidate_count: number;
  save_verified: boolean;
  quit_scheduled: boolean;
}

/**
 * One native command owns enumeration, persistence, revalidation, and optional
 * exit. Keeping this in one game-thread handler prevents the split Python
 * implementation from interpreting missing/malformed output as a clean save.
 */
export const editorSaveAllAndQuitHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) return errorResult(`Validation error: ${parsed.error.message}`);

  try {
    const result = await executeCommand<SaveQuitResult>('editor_save_all_and_quit', parsed.data);
    if (result.save_verified !== true || result.dirty_package_count_after !== 0) {
      return errorResult('editor_save_all_and_quit returned incomplete or contradictory save verification');
    }
    if (result.quit_scheduled !== parsed.data.quit) {
      return errorResult('editor_save_all_and_quit returned a quit state that contradicts the request');
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return errorResult(`editor_save_all_and_quit failed: ${error instanceof Error ? error.message : String(error)}`);
  }
};
