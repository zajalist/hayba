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
// Process-local capability flag: once we observe the UE plugin doesn't know
// `wait_for_idle`, fall back to the legacy `wait_for_shaders` command for the
// rest of this process. Lets us route through the new primitive when available
// without regressing live editors still running an older plugin build.
let waitForIdleAvailable: boolean | null = null;

export async function handleWaitForShaders(params: WaitForShadersParams) {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    return { content: [{ type: 'text' as const, text: 'Invalid params: ' + parsed.error.message }], isError: true };
  }
  if (params.poll_seconds !== undefined && !pollWarned) {
    pollWarned = true;
    console.warn('[wait-for-shaders] poll_seconds is ignored; UE-side polling is fixed at 250ms.');
  }

  const timeoutMs = parsed.data.max_seconds * 1000 + 5000;

  if (waitForIdleAvailable !== false) {
    try {
      const data = await executeCommand('wait_for_idle', {
        subsystems: ['shaders'],
        timeout_s: parsed.data.max_seconds,
      }, { timeout: timeoutMs });
      waitForIdleAvailable = true;
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      const msg = (err as Error)?.message ?? '';
      if (/unknown_command|unknown command|not registered/i.test(msg)) {
        waitForIdleAvailable = false;
        // fall through to legacy path
      } else {
        throw err;
      }
    }
  }

  // Legacy fallback for plugins that don't yet know `wait_for_idle`.
  const data = await executeCommand('wait_for_shaders', parsed.data as Record<string, unknown>, { timeout: timeoutMs });
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
