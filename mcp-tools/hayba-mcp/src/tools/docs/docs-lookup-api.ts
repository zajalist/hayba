import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'you are about to set a property or call a function on a UE class and want its real name, type and whether it is editable',
  not_when: 'you only need to know the class exists — docs_lookup_class is cheaper',
};

export const schema = z.object({
  path: z
    .string()
    .min(1)
    .describe('Class path or name, e.g. "/Script/UMG.TextBlock" or "TextBlock".'),
  include_inherited: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Include members inherited from parent classes. Off by default because the inherited surface of a UObject is large; turn it on when a member you expect is missing — it is often declared on a parent.',
    ),
});

export const docsLookupApiHandler: ToolHandler = ueTool('docs_lookup_api', schema);
