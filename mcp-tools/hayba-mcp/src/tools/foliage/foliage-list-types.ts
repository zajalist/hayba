import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'finding out which FoliageType assets the current level actually uses',
  not_when: 'you want instance counts or placement — this lists the types',
};

export const schema = z.object({
  // No parameters: the command reports the foliage types present in the level.
});

export const foliageListTypesHandler: ToolHandler = ueTool('foliage_list_types', schema);
