// Multi-agent editor leases: lease_acquire / lease_renew / lease_release / lease_status.
//
// Several agents can drive one editor. A lease says "I am working on this
// world / region / asset; do not change it under me". The editor never blocks
// on a lease: lease_acquire answers granted (lease_id) or queued (ticket,
// position, holder, ETA) and the agent polls with its ticket. Granted leases
// are renewed in the background by the LeaseKeeper until released.
//
// The handle is `lease_id`, never `token`: both redaction layers erase any
// value under a secret-shaped key, which is how every handle was lost before
// (postmortem I-5). `token` survives only as a deprecated input alias, and
// this server never sends it to the editor.
// See docs/adr/0010-multi-agent-editor-leases.md, "Lease ids".

import { z } from 'zod';
import type { ToolDescriptor } from '../register-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { executeCommand } from '../tool-executor.js';
import { getLeaseKeeper, isUsableLeaseId } from '../../lease-keeper.js';
import { isRedactionMarker } from '../../lease-id.js';

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
      .describe('Default true: a disconnect orphans the lease for up to 60 seconds, unless it expires sooner or its owner renews it.'),
  })
  .strict();

/** Same text as the editor's `deprecation` field (HaybaMCPLeaseHandler.cpp). */
export const TOKEN_DEPRECATION = "'token' was renamed to lease_id; send lease_id";

/** The editor's handler messages (HaybaMCPLeaseHandler.cpp), so a bad argument
 *  reads the same whichever side catches it. */
export const LEASE_ID_MESSAGES = {
  required: (cmd: string) => `${cmd} [lease_id_required]: lease_id is required; send the lease_id lease_acquire returned`,
  ambiguous: (cmd: string) =>
    `${cmd} [lease_id_ambiguous]: lease_id and its deprecated alias name different leases; send lease_id only`,
  redacted: (cmd: string) =>
    `${cmd} [lease_id_redacted]: the value is a redaction marker, not a lease_id; run lease_acquire again and send the lease_id it returns`,
  releaseExactlyOne: 'lease_release: [bad_request] send exactly one of lease_id, ticket or all:true',
} as const;

const leaseIdString = z.string().min(1).max(128);

/** Raw shapes: the descriptors' published schema (the transport validates these). */
export const leaseRenewShape = {
  lease_id: leaseIdString.optional().describe('The lease_id lease_acquire returned (ls_...). Omit it to renew every lease you hold.'),
  token: leaseIdString.optional().describe('Deprecated alias of lease_id; send lease_id.'),
  ttl_s: z.number().min(5).max(900).optional().describe('New lifetime from now, in seconds (max 900). Omitted: each lease keeps its own TTL.'),
};

export const leaseReleaseShape = {
  lease_id: leaseIdString.optional().describe('A lease you hold (the lease_id lease_acquire returned).'),
  token: leaseIdString.optional().describe('Deprecated alias of lease_id; send lease_id.'),
  ticket: leaseIdString.optional().describe('A queued request to withdraw (the ticket lease_acquire returned).'),
  all: z.literal(true).optional().describe('Release every lease and withdraw every ticket you hold.'),
};

type IdArgs = { lease_id?: string; token?: string };

/** Mirrors HaybaMCPLease::ResolveIdParam: the canonical value wins, the alias
 *  fills an empty canonical, two different values are ambiguous. */
function leaseIdProblem(cmd: 'lease_renew' | 'lease_release', v: IdArgs): string | null {
  if (v.lease_id !== undefined && v.token !== undefined && v.lease_id.trim() !== v.token.trim()) {
    return LEASE_ID_MESSAGES.ambiguous(cmd);
  }
  const id = v.lease_id ?? v.token;
  if (id !== undefined && isRedactionMarker(id.trim())) return LEASE_ID_MESSAGES.redacted(cmd);
  return null;
}

/** The lease a renew/release names: lease_id, else the deprecated alias. */
function namedLeaseId(v: IdArgs): string {
  return (v.lease_id ?? v.token ?? '').trim();
}

/** T7 (R5, R6): no id, or a redaction marker under the deprecated alias, renews
 *  every lease this owner holds. A marker under lease_id stays an error. */
function renewsByOwner(v: IdArgs): boolean {
  return v.lease_id === undefined && (v.token === undefined || isRedactionMarker(v.token.trim()));
}

export const leaseRenewSchema = z
  .object(leaseRenewShape)
  .strict()
  .superRefine((v, ctx) => {
    if (renewsByOwner(v)) return;
    const problem = leaseIdProblem('lease_renew', v);
    if (problem) ctx.addIssue({ code: 'custom', message: problem, path: ['lease_id'] });
  });

export const leaseReleaseSchema = z
  .object(leaseReleaseShape)
  .strict()
  .superRefine((v, ctx) => {
    const named = v.lease_id !== undefined || v.token !== undefined;
    const options = (named ? 1 : 0) + (v.ticket !== undefined ? 1 : 0) + (v.all ? 1 : 0);
    const problem = options !== 1
      ? LEASE_ID_MESSAGES.releaseExactlyOne
      : named
        ? leaseIdProblem('lease_release', v)
        : null;
    if (problem) ctx.addIssue({ code: 'custom', message: problem, path: ['lease_id'] });
  });

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
  if (data.status !== 'granted') return text(data);
  const ttlS = typeof data.ttl_s === 'number' ? data.ttl_s : (args.ttl_s ?? 120);
  if (isUsableLeaseId(data.lease_id) && getLeaseKeeper().track(data.lease_id, ttlS)) {
    return text({ ...data, auto_renew: true });
  }
  // A plugin that predates lease ids names the handle `token`, which the
  // editor's own redaction replaces with a marker. Nothing usable came back.
  return text({
    ...data,
    auto_renew: false,
    lease_id_error: 'missing_or_unusable',
    note: 'The editor granted the lease but returned no usable lease_id, so this server cannot renew or release it by id; it lapses at its TTL. Update the Hayba plugin. Your owner still matches the lease without an id.',
  });
}

export async function handleLeaseRenew(args: z.infer<typeof leaseRenewSchema>) {
  if (renewsByOwner(args)) {
    // No id, or a legacy marker under the alias: renew every lease this owner holds (R5, R6).
    return text(await getLeaseKeeper().renewAllByOwner(args.ttl_s));
  }

  const params: Record<string, unknown> = { lease_id: namedLeaseId(args) };
  if (args.ttl_s !== undefined) params.ttl_s = args.ttl_s;
  const data = await executeCommand<Record<string, unknown>>('lease_renew', params);
  return text(args.lease_id === undefined ? { ...data, deprecation: TOKEN_DEPRECATION } : data);
}

export async function handleLeaseRelease(args: z.infer<typeof leaseReleaseSchema>) {
  if (args.all) {
    // Stop every heartbeat first: a renew racing the release would only fail.
    getLeaseKeeper().stopAll();
    return text(await executeCommand('lease_release', { all: true }));
  }

  if (args.ticket !== undefined) {
    return text(await executeCommand('lease_release', { ticket: args.ticket.trim() }));
  }
  const id = namedLeaseId(args);
  if (args.lease_id === undefined && id.startsWith('lq_')) {
    // Old callers withdrew a queued ticket under `token`.
    const withdrawn = await executeCommand<Record<string, unknown>>('lease_release', { ticket: id });
    return text({ ...withdrawn, deprecation: TOKEN_DEPRECATION });
  }
  // Stop the heartbeat first: a renew racing the release would only fail.
  getLeaseKeeper().untrack(id);
  const data = await executeCommand<Record<string, unknown>>('lease_release', { lease_id: id });
  return text(args.lease_id === undefined ? { ...data, deprecation: TOKEN_DEPRECATION } : data);
}

export async function handleLeaseStatus() {
  const data = await executeCommand<Record<string, unknown>>('lease_status', {});
  return text({ ...data, renewing_lease_ids: getLeaseKeeper().heldLeaseIds() });
}

export const LEASE_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: 'lease_acquire',
    description:
      'Reserve part of the editor (world, World Partition region, asset, actor, PIE, or everything) so other agents do not change it mid-sequence. Never blocks: returns {status:"granted", lease_id} or {status:"queued", ticket, position, holder_owner, eta_s, poll_after_s}; poll by calling again with ticket. Granted leases are renewed automatically until lease_release.',
    meta: acquireMeta,
    handler: validated(leaseAcquireSchema, handleLeaseAcquire) as never,
    cost: 'low',
    returns:
      '{status:"granted", lease_id, reused, ttl_s, max_ttl_s, orphan_grace_s, bind_connection, expires_in_s, resources, next} | {status:"queued", ticket, position, holder_owner, eta_s, poll_after_s}',
    schema: leaseAcquireSchema.shape,
  },
  {
    name: 'lease_renew',
    description:
      'Extend leases you hold. With lease_id, that lease; with nothing, every lease you hold, which also revives leases the editor orphaned when this server\'s connection dropped. Rarely needed: leases granted by lease_acquire are renewed in the background.',
    meta: renewMeta,
    handler: validated(leaseRenewSchema, handleLeaseRenew) as never,
    cost: 'low',
    returns: '{lease_id, renewed, expires_in_s} | {owner, renewed:N, expires_in_s, leases:[{lease_id, resources, expires_in_s, orphaned}]}',
    schema: leaseRenewShape,
  },
  {
    name: 'lease_release',
    description:
      'Release a lease (lease_id), withdraw a queued ticket (ticket), or release everything you hold (all:true). Send exactly one. Other agents waiting on it can then be granted.',
    meta: releaseMeta,
    handler: validated(leaseReleaseSchema, handleLeaseRelease) as never,
    cost: 'low',
    returns: '{lease_id, released} | {ticket, released} | {owner, released:N, tickets_withdrawn:M}',
    schema: leaseReleaseShape,
  },
  {
    name: 'lease_status',
    description:
      'Who holds or waits for which editor resources, the enforcement mode, and which of your leases this server is renewing.',
    meta: statusMeta,
    handler: async () => handleLeaseStatus() as never,
    cost: 'low',
    returns: '{enforcement, caller_owner, current_world, max_ttl_s, orphan_grace_s, leases:[{owner, mine, lease_id?, label?, resources, lane, held_s, expires_in_s, bound_to_connection, orphaned, bind_connection, ttl_s}], waiters:[...], renewing_lease_ids}',
    schema: {},
  },
];
