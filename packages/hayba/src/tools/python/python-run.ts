import { z } from 'zod';
import type { ToolHandler } from '../hayba-bake-terrain.js';
import { ensureConnected } from '../../tcp-client.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

// TODO: wire into registerTools with RateLimiter + ToolCache + appendMeta wrapper

export const meta: HaybaToolMeta = {
  cost: 'high',
  effects: ['runs_arbitrary_python', 'unknown_side_effects'],
  when: "executing a Python script via UE's PythonScriptPlugin for tasks not exposed by other commands",
  not_when: 'an existing actor_/asset_/blueprint_ command can do the job — prefer those',
};

export const schema = z.object({
  script: z.string().min(1),
  allow_unsafe: z.boolean().optional(),
});

export const pythonRunHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  try {
    const client = await ensureConnected();
    const resp = await client.send('python_run', parsed.data as Record<string, unknown>);
    const data = (resp.data ?? {}) as Record<string, unknown>;
    if (!resp.ok) {
      if (data.tier === 3) {
        return {
          content: [{
            type: 'text',
            text: `Tier 3 (filesystem/subprocess) access blocked. Set bAllowUnsafePython=true in plugin settings or pass allow_unsafe:true to override (DANGEROUS). Underlying error: ${resp.error ?? 'unknown'}`,
          }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: `python_run failed: ${resp.error ?? 'unknown error'}` }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(resp.data, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `python_run error: ${(e as Error).message}` }], isError: true };
  }
};
