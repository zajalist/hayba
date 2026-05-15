import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ensureConnected } from '../../tcp-client.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'tailing recent log lines from the UE editor (e.g. during PIE) — caller pages by tracking since_line in their own state',
  not_when: 'you need a one-shot snapshot — use editor_get_output_log instead',
};

export const schema = z.object({
  filter: z.string().optional(),
  since_line: z.number().int().nonnegative().optional(),
});

export const editorStreamLogHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  try {
    const client = await ensureConnected();
    const resp = await client.send('editor_stream_log', parsed.data as Record<string, unknown>);
    if (!resp.ok) {
      return { content: [{ type: 'text', text: `editor_stream_log failed: ${resp.error ?? 'unknown error'}` }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(resp.data, null, 2) }] };
  } catch (e: unknown) {
    return { content: [{ type: 'text', text: `editor_stream_log error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
};
