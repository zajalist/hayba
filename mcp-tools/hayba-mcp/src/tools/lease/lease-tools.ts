// Multi-agent editor leases: lease_acquire / lease_renew / lease_release / lease_status.
//
// Several agents can drive one editor. A lease says "I am working on this
// world / region / asset; do not change it under me". The editor never blocks
// on a lease: lease_acquire answers granted (token) or queued (ticket,
// position, holder, ETA) and the agent polls with its ticket. Granted leases
// are renewed in the background by the LeaseKeeper until released.
// See docs/adr/0010-multi-agent-editor-leases.md.

import { z } from 'zod';
import type { ToolDescriptor } from '../register-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { executeCommand } from '../tool-executor.js';
import { getLeaseKeeper } from '../../lease-keeper.js';

const resourceString = z
  .string()
  .min(1)
  .max(512)
  .describe(
    'global | pie | world:<package> | wp-region:<package>:<minX>,<minY>,<maxX>,<maxY> | asset:<path> | actor:<object path>. Example: world:/Game/Maps/Valley.',
  );

const resourceItem = z.union([
  resourceString,
  z
    .object({
      resource: resourceString,
      mode: z.enum(['shared', 'exclusive']).optional().describe('Overrides the request-level mode for this resource.'),
    })
    .strict(),
]);

export const leaseAcquireSchema = z
  .object({
    resources: z
      .array(resourceItem)
      .min(1)
      .max(32)
      .optional()
      .describe('What to lock. Required unless ticket is given.'),
    mode: z
      .enum(['shared', 'exclusive'])
      .optional()
      .describe('Default exclusive. Shared lets other readers hold the same resource.'),
    ttl_s: z
      .number()
      .min(5)
      .max(900)
      .optional()
      .describe('Lease lifetime in seconds (default 120, max 900). Renewed automatically while this server runs.'),
    lane: z
      .enum(['interactive', 'long'])
      .optional()
      .describe('interactive (default) is served first; long is for bulk work and ages to the front after a while.'),
    ticket: z.string().optional().describe('The ticket from an earlier queued answer, to poll for the grant.'),
    label: z.string().max(128).optional().describe('What the lease is for, shown to other agents in lease_status.'),
    bind_connection: z
      .boolean()
      .optional()
      .describe('Default true: the editor releases the lease if this server disconnects.'),
  })
  .strict();

export const leaseTokenSchema = z
  .object({
    token: z.string().min(1).describe('A lease token (or, for lease_release, a queued ticket).'),
    ttl_s: z.number().min(5).max(900).optional().describe('lease_renew only: new lifetime from now.'),
  })
  .strict();

const acquireMeta: HaybaToolMeta = {
  cost: 'low',
  effects: ['coordination'],
  when: 'another agent may be editing the same editor and you are about to run a multi-step change, a save, a World Partition load/unload, or a python_run with deadline_s above 5',
  not_when: 'you only read state, or you are the only agent connected to this editor',
};

const renewMeta: HaybaToolMeta = {
  cost: 'low',
  effects: ['coordination'],
  when: 'extending a lease by hand (the server already renews leases it granted in the background)',
  not_when: 'the lease was acquired through lease_acquire in this server; it is renewed automatically',
};

const releaseMeta: HaybaToolMeta = {
  cost: 'low',
  effects: ['coordination'],
  when: 'you finished the work a lease protected, or you want to leave a lease queue',
  not_when: 'you still have steps left that depend on nobody else touching the resource',
};

const statusMeta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'a command came back with lease_conflict or lease_warning, or before acquiring, to see who holds what',
  not_when: 'you already hold the lease you need',
};

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/** Validate like ueTool does: a bad argument is a tool error, not a throw. */
function validated<S extends z.ZodTypeAny>(schema: S, run: (args: z.infer<S>) => Promise<unknown>) {
  return async (args: unknown) => {
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      return { content: [{ type: 'text' as const, text: `Validation error: ${parsed.error.message}` }], isError: true };
    }
    return run(parsed.data);
  };
}

export async function handleLeaseAcquire(args: z.infer<typeof leaseAcquireSchema>) {
  const data = await executeCommand<Record<string, unknown>>('lease_acquire', args as Record<string, unknown>);
  if (data.status === 'granted' && typeof data.token === 'string') {
    getLeaseKeeper().track(data.token, args.ttl_s ?? 120);
    data.auto_renew = true;
  }
  return text(data);
}

export async function handleLeaseRenew(args: z.infer<typeof leaseTokenSchema>) {
  return text(await executeCommand('lease_renew', args as Record<string, unknown>));
}

export async function handleLeaseRelease(args: z.infer<typeof leaseTokenSchema>) {
  // Stop the heartbeat first: a renew racing the release would only fail.
  getLeaseKeeper().untrack(args.token);
  return text(await executeCommand('lease_release', { token: args.token }));
}

export async function handleLeaseStatus() {
  const data = await executeCommand<Record<string, unknown>>('lease_status', {});
  return text({ ...data, renewing_tokens: getLeaseKeeper().heldTokens() });
}

export const LEASE_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: 'lease_acquire',
    description:
      'Reserve part of the editor (world, World Partition region, asset, actor, PIE, or everything) so other agents do not change it mid-sequence. Never blocks: returns {status:"granted", token} or {status:"queued", ticket, position, holder_owner, eta_s, poll_after_s}; poll by calling again with ticket. Granted leases are renewed automatically until lease_release.',
    meta: acquireMeta,
    handler: validated(leaseAcquireSchema, handleLeaseAcquire) as never,
    cost: 'low',
    returns:
      '{status:"granted", token, expires_in_s, resources} | {status:"queued", ticket, position, holder_owner, eta_s, poll_after_s}',
    schema: leaseAcquireSchema.shape,
  },
  {
    name: 'lease_renew',
    description:
      'Extend a lease you hold. Rarely needed: leases granted by lease_acquire are renewed in the background.',
    meta: renewMeta,
    handler: validated(leaseTokenSchema, handleLeaseRenew) as never,
    cost: 'low',
    returns: '{token, renewed, expires_in_s}',
    schema: leaseTokenSchema.shape,
  },
  {
    name: 'lease_release',
    description:
      'Release a lease you hold, or withdraw a queued ticket. Other agents waiting on it can then be granted.',
    meta: releaseMeta,
    handler: validated(leaseTokenSchema, handleLeaseRelease) as never,
    cost: 'low',
    returns: '{token, released}',
    schema: leaseTokenSchema.shape,
  },
  {
    name: 'lease_status',
    description:
      'Who holds or waits for which editor resources, the enforcement mode (off/advisory/enforced), and which of your leases this server is renewing.',
    meta: statusMeta,
    handler: async () => handleLeaseStatus() as never,
    cost: 'low',
    returns: '{enforcement, caller_owner, current_world, leases:[...], waiters:[...], renewing_tokens}',
    schema: {},
  },
];
