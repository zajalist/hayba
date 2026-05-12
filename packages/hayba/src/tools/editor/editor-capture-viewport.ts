import { z } from 'zod';
import type { ToolHandler } from '../hayba-bake-terrain.js';
import { ensureConnected } from '../../tcp-client.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

// TODO: wire into registerTools with RateLimiter + ToolCache + appendMeta wrapper

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['gpu_load'],
  when: 'the agent needs to see the current scene visually',
  not_when: 'you only need actor positions — use actor_list or scene_export',
};

export const schema = z.object({
  width: z.number().int().optional().default(1280),
  height: z.number().int().optional().default(720),
});

export const editorCaptureViewportHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  try {
    const client = await ensureConnected();
    const resp = await client.send('editor_capture_viewport', parsed.data as Record<string, unknown>);
    if (!resp.ok) {
      return { content: [{ type: 'text', text: `editor_capture_viewport failed: ${resp.error ?? 'unknown error'}` }], isError: true };
    }
    let text = JSON.stringify(resp.data, null, 2);
    if (process.env.HAYBA_SIDECAR_URL) {
      text += `\n\nSidecar embedding integration pending (Task 20)`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `editor_capture_viewport error: ${(e as Error).message}` }], isError: true };
  }
};
