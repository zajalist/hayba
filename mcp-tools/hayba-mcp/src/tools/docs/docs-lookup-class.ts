import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'checking what a UE class actually is — its inheritance chain and how many properties and functions it exposes',
  not_when: 'you need the property or function NAMES — use docs_lookup_api',
};

export const schema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      'Class path or name, e.g. "/Script/UMG.UserWidget", "UserWidget", or "TextBlock". Resolved against the LIVE editor, so it reflects the engine version and plugins actually loaded.',
    ),
});

export const docsLookupClassHandler: ToolHandler = ueTool('docs_lookup_class', schema);
