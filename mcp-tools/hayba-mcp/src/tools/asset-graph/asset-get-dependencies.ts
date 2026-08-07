import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'finding out what an asset pulls in — what must exist for it to load',
  not_when: 'you want what depends ON it (use asset_get_referencers)',
};

export const schema = z.object({
  path: z.string().min(1).describe('Asset path whose dependencies to list'),
});

export const assetGetDependenciesHandler: ToolHandler = ueTool('asset_get_dependencies', schema);
