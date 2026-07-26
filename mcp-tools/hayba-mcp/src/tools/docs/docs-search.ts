import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'you need the real name of a UE class and are about to guess at one',
  not_when: 'you already have the exact class path — use docs_lookup_class directly',
};

export const schema = z.object({
  query: z
    .string()
    .min(1)
    .describe('Substring to match against class names, case-insensitive. "Widget", "Landscape", "StaticMesh".'),
  kind: z
    .enum(['class', 'all'])
    .optional()
    .default('class')
    .describe('What to search. Currently classes; "all" is reserved for future kinds.'),
});

export const docsSearchHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('docs_search', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
