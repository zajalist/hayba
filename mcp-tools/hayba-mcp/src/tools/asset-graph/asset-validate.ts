import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: [],
  when: 'running the editor data-validation rules over an asset before relying on it',
  not_when: 'checking UI layout specifically (use ui_validate)',
};

export const schema = z.object({
  path: z.string().min(1).describe('Asset or folder path to validate'),
});

export const assetValidateHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('asset_validate', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
