import { z } from 'zod';
import type { HaybaToolMeta } from './hayba-tool-meta.js';
import { executeCommand } from './tool-executor.js';

const SUBSYSTEMS = ['shaders', 'assets', 'gc', 'pcg', 'world_tick'] as const;

export const schema = z.object({
  subsystems: z.array(z.enum(SUBSYSTEMS)).optional()
    .describe('Subsystems to wait on. Omit = wait for all five.'),
  timeout_s: z.number().int().min(1).max(600).default(60)
    .describe('Hard timeout in seconds.'),
  pcg_actors: z.array(z.string()).optional()
    .describe('Optional scope: only wait on these PCGComponent owners (full actor paths). Omit = all PCG actors in the active level.'),
  world_ticks: z.number().int().min(1).max(60).optional()
    .describe('When world_tick is in subsystems: wait at least N world ticks past request start. Default 1.'),
});

export type WaitForIdleParams = z.infer<typeof schema>;

export const meta: HaybaToolMeta = {
  cost: 'high',
  effects: ['wait'],
  when: 'After mutating asset/PCG/level state, before reading back or rendering.',
  not_when: 'You did a pure read-only call; no state was mutated.',
};

export async function handleWaitForIdle(params: WaitForIdleParams) {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    return { content: [{ type: 'text' as const, text: 'Invalid params: ' + parsed.error.message }], isError: true };
  }
  const data = await executeCommand('wait_for_idle', parsed.data as Record<string, unknown>, {
    timeout: parsed.data.timeout_s * 1000 + 5000,
  });
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
