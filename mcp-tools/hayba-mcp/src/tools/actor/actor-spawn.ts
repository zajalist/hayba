import { z } from 'zod';
import { join } from 'node:path';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { runAfterTool } from '../../validator/runner.js';
import { attachFindingsToValue } from '../../validator/response.js';

// TODO: wire into registerTools with RateLimiter + ToolCache + appendMeta wrapper

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['spawns_actor', 'modifies_level'],
  when: 'placing a new asset instance in the active level',
  not_when: 'duplicating an existing actor (use actor_duplicate) or just moving one (actor_transform)',
};

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

export const schema = z.object({
  class_path: z.string().min(1)
    .describe('Either a UClass path (/Script/Engine.DirectionalLight, /Game/.../BP_Foo.BP_Foo_C) OR a StaticMesh/SkeletalMesh asset path (/Game/.../SM_Tree.SM_Tree) — the latter auto-wraps in a Static/SkeletalMeshActor.'),
  location: vec3.optional(),
  rotation: vec3.optional(),
  scale: vec3.optional(),
  label: z.string().optional(),
  snap_to_landscape: z.boolean().optional()
    .describe('After spawn, line-trace from above the spawn XY down to the landscape surface and set the actor Z to that hit (plus z_offset). Prefer this over python_run line traces when placing props onto terrain.'),
  z_offset: z.number().optional()
    .describe('Added to the snapped Z. Useful for assets whose pivot is not at the visible base (e.g. SM_GiantTree_01 needs -380). Ignored when snap_to_landscape is false.'),
});

export const actorSpawnHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('actor_spawn', parsed.data as Record<string, unknown>);

  // Post-condition: surface actor_spawn_not_on_landscape and any future
  // actor-spawn rules. Lazy-import the TCP client to keep this module
  // import-safe in pure-TS tests.
  let ue = null;
  try {
    const tcpMod = await import('../../tcp-client.js');
    ue = await tcpMod.ensureConnected().catch(() => null);
  } catch {
    ue = null;
  }
  const findings = await runAfterTool({
    toolName: 'actor_spawn',
    toolArgs: parsed.data as Record<string, unknown>,
    toolResult: data as Record<string, unknown>,
    ue,
    scratchDir: join(process.cwd(), '.scratch'),
  });
  const enriched = attachFindingsToValue(data as Record<string, unknown>, findings);
  return { content: [{ type: 'text', text: JSON.stringify(enriched, null, 2) }] };
};
