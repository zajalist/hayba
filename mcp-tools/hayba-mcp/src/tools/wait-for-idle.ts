import { z } from 'zod';
import type { HaybaToolMeta } from './hayba-tool-meta.js';
import { executeCommand } from './tool-executor.js';

const SUBSYSTEMS = ['shaders', 'assets', 'gc', 'pcg', 'world_tick'] as const;

// world_tick is excluded from the default set: in the editor the world is
// essentially always "busy on entry", so gating on it makes wait_for_idle
// time out / report not-settled every time (a false-positive source). Callers
// who genuinely need a tick barrier can still request it explicitly.
// See docs/HANDOFF-mcp-agent-ergonomics-postmortem.md (P2).
const DEFAULT_SUBSYSTEMS = ['shaders', 'assets', 'gc', 'pcg'] as const;

export const schema = z.object({
  subsystems: z.array(z.enum(SUBSYSTEMS)).optional()
    .describe('Subsystems to wait on. Omit = shaders+assets+gc+pcg (world_tick excluded by default — it is always "busy" in-editor and yields false not-settled; request it explicitly only if you truly need a tick barrier).'),
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
  // Inject the safe default subsystem set when the caller omits it, so an
  // unscoped wait doesn't gate on the always-busy world_tick.
  const payload: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.subsystems === undefined) {
    payload.subsystems = [...DEFAULT_SUBSYSTEMS];
  }
  const data = await executeCommand('wait_for_idle', payload, {
    timeout: parsed.data.timeout_s * 1000 + 5000,
  });
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
