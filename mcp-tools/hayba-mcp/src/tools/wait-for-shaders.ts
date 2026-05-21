import { z } from 'zod';
import { executeCommand } from './tool-executor.js';
import type { HaybaToolMeta } from './hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'high',
  effects: [],
  when: 'waiting for UE shader compilation to settle before taking a screenshot or executing a graph that touches new materials',
  not_when: 'you do not actually care if shaders are still compiling (most read-only tools)',
};

export const schema = z.object({
  max_seconds: z.number().int().min(1).max(600).default(60),
  poll_seconds: z.number().min(0.05).max(10).default(1),
});

export type WaitForShadersParams = z.infer<typeof schema>;

let pollWarned = false;

export async function handleWaitForShaders(params: WaitForShadersParams) {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    return { content: [{ type: 'text' as const, text: 'Invalid params: ' + parsed.error.message }], isError: true };
  }
  // poll_seconds is no longer honoured — UE-side polling is fixed at 250ms in
  // the new wait_for_idle handler. Warn once per process for callers that
  // still pass it.
  if (params.poll_seconds !== undefined && !pollWarned) {
    pollWarned = true;
    console.warn('[wait-for-shaders] poll_seconds is ignored; UE-side polling is fixed at 250ms.');
  }
  const data = await executeCommand('wait_for_idle', {
    subsystems: ['shaders'],
    timeout_s: parsed.data.max_seconds,
  }, { timeout: parsed.data.max_seconds * 1000 + 5000 });
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
