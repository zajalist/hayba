import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: [],
  when: 'running the editor data-validation rules over an asset before relying on it',
  not_when: 'checking UI layout specifically (use ui_validate)',
};

export const schema = z.object({
  path: z.string().min(1).describe('Asset or folder path to validate'),
  max_assets: z.number().int().min(1).max(1000).optional().describe(
    'Maximum primary assets to validate (default 100). Larger folders are refused before validation; narrow the path or raise the bound. Validators can still inspect external objects and dependencies.',
  ),
});

export const assetValidateHandler: ToolHandler = ueTool('asset_validate', schema);
