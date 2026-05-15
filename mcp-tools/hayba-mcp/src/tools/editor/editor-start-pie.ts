import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ensureConnected } from '../../tcp-client.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

// TODO: wire into registerTools with RateLimiter + ToolCache + appendMeta wrapper

export const meta: HaybaToolMeta = {
  cost: 'high',
  effects: ['starts_pie_session'],
  when: 'starting Play-In-Editor to test runtime behavior',
  not_when: 'the editor is already in PIE — call editor_stop_pie first',
};

export const schema = z.object({
  single_step: z.boolean().optional().default(false),
});

export const editorStartPieHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  try {
    const client = await ensureConnected();
    const resp = await client.send('editor_start_pie', parsed.data as Record<string, unknown>);
    if (!resp.ok) {
      return { content: [{ type: 'text', text: `editor_start_pie failed: ${resp.error ?? 'unknown error'}` }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(resp.data, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `editor_start_pie error: ${(e as Error).message}` }], isError: true };
  }
};
