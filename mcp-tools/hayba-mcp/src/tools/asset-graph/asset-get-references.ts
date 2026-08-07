import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'you want both directions of an asset reference graph in one call',
  not_when: 'you only need one direction — the single-direction tools return an exact count rather than a capped list',
};

export const schema = z.object({
  path: z.string().min(1).describe('Asset path to inspect'),
});

export const assetGetReferencesHandler: ToolHandler = ueTool('asset_get_references', schema);
