// editor_batch / batch_status: several editor commands under one lease, run in
// order on the game thread with a fence after each step.
//
// The editor runs ONE step per tick through the normal command path. After a
// step, its fence waits (across ticks, never blocking the game thread) for
// shaders, asset loads, GC and async loading to settle; `gc` also collects
// garbage when the lease is exclusive on a region, world or everything. Other
// agents' queued interactive lease requests are granted at fences. The
// wp_region_load / wp_region_unload steps load World Partition regions with a
// loader adapter the batch owns, so every region is released by the time the
// batch ends. See docs/adr/0010-multi-agent-editor-leases.md.

import { z } from 'zod';
import type { ToolDescriptor } from '../register-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { executeCommand } from '../tool-executor.js';
import { getLeaseKeeper } from '../../lease-keeper.js';

export const BATCH_MAX_STEPS = 64;

const boundsSchema = z.union([
  z.tuple([z.number(), z.number(), z.number(), z.number()]).describe('[minX, minY, maxX, maxY] in world units'),
  z
    .object({
      min: z.union([z.tuple([z.number(), z.number()]), z.object({ x: z.number(), y: z.number() })]),
      max: z.union([z.tuple([z.number(), z.number()]), z.object({ x: z.number(), y: z.number() })]),
    })
    .strict(),
]);

export const batchStepSchema = z
  .object({
    cmd: z
      .string()
      .min(1)
      .max(128)
      .describe(
        'An editor command name (as hayba_invoke would send it), or wp_region_load {bounds, name?} / wp_region_unload {name?}.',
      ),
    params: z.record(z.string(), z.unknown()).optional().describe('The command params. Paths, never object handles.'),
    fence_after: z
      .enum(['none', 'idle', 'gc'])
      .optional()
      .describe(
        'idle (default): wait for idle_ticks consecutive idle ticks. gc: collect garbage first (exclusive region/world lease only), then idle. none: next tick.',
      ),
  })
  .strict()
  .superRefine((step, ctx) => {
    if (step.cmd === 'wp_region_load') {
      const parsed = boundsSchema.safeParse(step.params?.bounds);
      if (!parsed.success) {
        ctx.addIssue({
          code: 'custom',
          message: 'wp_region_load needs params.bounds: [minX, minY, maxX, maxY] or {min:[x,y], max:[x,y]}',
          path: ['params', 'bounds'],
        });
      }
    }
    if (step.cmd === 'editor_batch') {
      ctx.addIssue({ code: 'custom', message: 'editor_batch cannot be nested', path: ['cmd'] });
    }
    if (step.cmd === 'lease_acquire' || step.cmd === 'lease_release') {
      ctx.addIssue({
        code: 'custom',
        message: `${step.cmd} cannot run inside a batch; the batch runs under the lease it was given`,
        path: ['cmd'],
      });
    }
  });

export const editorBatchSchema = z
  .object({
    lease_id: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe('The lease_id from lease_acquire this batch runs under. Optional only when this server holds exactly one lease.'),
    lease: z.string().min(1).max(128).optional().describe('Same as lease_id (kept for existing callers).'),
    steps: z.array(batchStepSchema).min(1).max(BATCH_MAX_STEPS),
    on_error: z
      .enum(['stop', 'unload_then_stop'])
      .optional()
      .describe(
        'stop (default): halt at the failing step. unload_then_stop: halt, release loaded regions, then settle (idle, and gc if allowed) before reporting done. Regions are released in both cases.',
      ),
    idle_ticks: z.number().int().min(1).max(120).optional().describe('Consecutive idle ticks a fence needs (default 2).'),
    fence_timeout_s: z
      .number()
      .min(1)
      .max(1800)
      .optional()
      .describe('A fence that never settles fails its step after this long (default 120).'),
  })
  .strict();

/** editor_batch arguments as the handler accepts them: lease_id and lease may
 *  not name different leases (the editor answers the same way). */
export const editorBatchArgsSchema = editorBatchSchema.superRefine((v, ctx) => {
  if (v.lease_id !== undefined && v.lease !== undefined && v.lease_id.trim() !== v.lease.trim()) {
    ctx.addIssue({
      code: 'custom',
      message: 'editor_batch [lease_id_ambiguous]: lease_id and lease name different leases; pass one',
      path: ['lease_id'],
    });
  }
});

export const batchStatusSchema = z
  .object({
    job_id: z.string().min(1),
    wait_s: z
      .number()
      .min(0)
      .max(120)
      .optional()
      .describe('Poll until the batch is done or this many seconds pass (default 0: answer now).'),
  })
  .strict();

const batchMeta: HaybaToolMeta = {
  cost: 'low',
  effects: ['mutates_world', 'coordination'],
  when: 'a multi-step editor change (World Partition region load, edit, save, unload) must run in order without another agent interleaving, or needs the editor to settle (shaders, loads, GC) between steps',
  not_when: 'a single command does the job, or you have not acquired a lease on what the steps touch',
};

const statusMeta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'following an editor_batch job until it finishes',
  not_when: 'you have no editor_batch job id',
};

function text(data: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], ...(isError ? { isError } : {}) };
}

function validated<S extends z.ZodTypeAny>(schema: S, run: (args: z.infer<S>) => Promise<unknown>) {
  return async (args: unknown) => {
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      return { content: [{ type: 'text' as const, text: `Validation error: ${parsed.error.message}` }], isError: true };
    }
    return run(parsed.data);
  };
}

/** The lease a batch runs under: the one named, else the single lease this server holds. */
export function resolveBatchLease(explicit: string | undefined, held: string[]): { lease?: string; error?: string } {
  if (explicit) return { lease: explicit.trim() };
  if (held.length === 1) return { lease: held[0] };
  if (held.length === 0) {
    return {
      error:
        'editor_batch needs a lease: call lease_acquire for what the steps touch (e.g. world:/Game/Maps/Valley or a wp-region), then pass its lease_id.',
    };
  }
  return { error: `this server holds ${held.length} leases; pass the one this batch runs under as lease_id.` };
}

export async function handleEditorBatch(args: z.infer<typeof editorBatchSchema>) {
  const { lease: aliasLease, lease_id: leaseIdArg, ...rest } = args;
  const { lease, error } = resolveBatchLease(leaseIdArg ?? aliasLease, getLeaseKeeper().heldLeaseIds());
  if (!lease) return text({ error }, true);
  return text(await executeCommand('editor_batch', { ...rest, lease_id: lease }));
}

export interface BatchStatusDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function handleBatchStatus(args: z.infer<typeof batchStatusSchema>, deps: BatchStatusDeps = {}) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const deadline = now() + (args.wait_s ?? 0) * 1000;
  for (;;) {
    const data = await executeCommand<Record<string, unknown>>('batch_status', { job_id: args.job_id });
    if (data.status !== 'running' || now() >= deadline) return text(data);
    await sleep(Math.min(1000, Math.max(0, deadline - now())));
  }
}

export const BATCH_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: 'editor_batch',
    description:
      'Run several editor commands in order under one lease, one step per editor tick, with a fence after each (wait for shaders/asset loads/GC/async loading to settle; gc also collects garbage under an exclusive region/world lease). Returns {job_id} at once; follow it with batch_status. Steps may be wp_region_load {bounds:[minX,minY,maxX,maxY], name?} / wp_region_unload {name?}: the batch owns those World Partition regions and always releases them by the end. Other agents\' queued interactive lease requests are served at fences. The batch keeps its own lease alive and runs to the end of its steps even if this server disconnects.',
    meta: batchMeta,
    handler: validated(editorBatchArgsSchema, handleEditorBatch) as never,
    cost: 'low',
    returns: '{job_id, status:"running", steps_total, owner, on_error, plan_covered}',
    schema: editorBatchSchema.shape,
  },
  {
    name: 'batch_status',
    description:
      'Progress or result of an editor_batch job: status running|succeeded|failed, phase, the step it is on, what a fence is waiting for, per-step results, loaded regions, yields to other agents. wait_s polls until done.',
    meta: statusMeta,
    handler: validated(batchStatusSchema, (a) => handleBatchStatus(a)) as never,
    cost: 'low',
    returns:
      '{job_id, status, phase, step_index, steps_total, steps_run, busy?, failed_step?, error?, loaded_regions, steps:[{index, cmd, state, error?, data?}], notes}',
    schema: batchStatusSchema.shape,
  },
];
