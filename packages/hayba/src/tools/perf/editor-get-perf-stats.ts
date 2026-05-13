import { z } from 'zod';
import { ensureConnected } from '../../tcp-client.js';
import type { ToolHandler } from '../types.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['gpu_load'],
  when: 'auditing scene perf — frame time, draw calls, triangle count, memory',
  not_when: 'asking about specific assets — use texture_audit or mesh_audit',
};

export const schema = z.object({
  sample_frames: z.number().int().min(1).max(120).optional()
    .describe('How many frames to average. Default 30.'),
});

export const editorGetPerfStatsHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  try {
    const client = await ensureConnected();
    const resp = await client.send('editor_get_perf_stats', parsed.data as Record<string, unknown>, 10_000);
    if (!resp.ok) {
      return { content: [{ type: 'text', text: `editor_get_perf_stats failed: ${resp.error ?? 'unknown'}` }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(resp.data, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `editor_get_perf_stats error: ${(e as Error).message}` }], isError: true };
  }
};
