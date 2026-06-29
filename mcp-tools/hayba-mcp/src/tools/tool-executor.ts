import type { HaybaToolCost } from './hayba-tool-meta.js';
import type { TcpResponse } from '../tcp-client.js';
import { getToolMeta } from './tool-meta-registry.js';

export type UeToolErrorCode =
  | 'transport'
  | 'timeout'
  | 'plan_gate'
  | 'tool_disabled'
  | 'ue_error';

export class UeToolError extends Error {
  readonly code: UeToolErrorCode;
  readonly uePayload?: unknown;
  constructor(message: string, opts: { code: UeToolErrorCode; uePayload?: unknown }) {
    super(message);
    this.name = 'UeToolError';
    this.code = opts.code;
    this.uePayload = opts.uePayload;
  }
}

const KNOWN_UE_CODES = new Set<UeToolErrorCode>(['plan_gate', 'tool_disabled']);
function mapUeCode(raw: string | undefined): UeToolErrorCode {
  if (raw && KNOWN_UE_CODES.has(raw as UeToolErrorCode)) return raw as UeToolErrorCode;
  return 'ue_error';
}

// Timeout tiers mapped to UE operation ceilings:
//   low    →  2 s  (fast queries, property reads)
//   medium → 10 s  (graph rebuilds, property writes)
//   high   → 120 s (build/compile/shader-warm/landscape-import; UE build ceiling
//                   is 300 s, test ceiling 120 s — both will move to the async
//                   job envelope in Task 9; until then high-cost ops must not
//                   pre-time-out while UE is still working)
const COST_TIMEOUTS_MS: Record<HaybaToolCost, number> = {
  low:    2_000,
  medium: 10_000,
  high:   120_000,
};

/**
 * Commands that MUST NOT be auto-retried on transport failure because a
 * duplicate execution would cause real side-effects (duplicate actors,
 * orphaned assets, double-deletes, etc.).
 *
 * Unknown commands default to IDEMPOTENT (retry allowed) to preserve the
 * existing retry behaviour — only commands in this set skip the retry.
 */
export const NON_IDEMPOTENT = new Set<string>([
  // Actor lifecycle
  'actor_spawn',
  'actor_delete',
  'actor_duplicate',
  'actor_batch_spawn',
  // Asset lifecycle
  'asset_delete',
  'asset_duplicate',
  'asset_import',
  'asset_rename',
  // Landscape
  'landscape_import',
  // Level authoring
  'level_create',
  // Blueprint authoring
  'blueprint_create',
  // Material authoring
  'material_create',
  'material_create_instance',
  // Material add-element family (append mutations — duplicate nodes/edges on retry)
  'material_add_node',
  'material_add_comment',
  'material_add_reroute_declaration',
  'material_add_reroute_usage',
  'material_connect_nodes',
  // PCG
  'pcg_create_graph',
  // PCG add-element family (MCP-registered; routed via python_run internally)
  'pcg_add_node',
  'pcg_wire',
  // ISM
  'ism_create_actor',
  'ism_clear_instances',
  // ISM add-element family
  'ism_add_instances',
  // Foliage
  'foliage_remove_instances',
  // Spline
  'spline_create',
  // Sequencer
  'seq_create',
  // Niagara
  'niagara_spawn',
  // MetaSound
  'metasound_create',
  // GAS
  'gas_create_ability',
  'gas_create_effect',
  // UI
  'ui_create_widget',
  // Data
  'data_create',
  // Input
  'input_create_action',
  'input_create_mapping',
]);

export function costToTimeoutMs(cost: HaybaToolCost | undefined): number {
  if (cost && cost in COST_TIMEOUTS_MS) return COST_TIMEOUTS_MS[cost];
  return COST_TIMEOUTS_MS.medium;
}

export type Sender = (
  cmd: string,
  params: Record<string, unknown>,
  timeoutMs: number,
) => Promise<TcpResponse>;

export interface ExecuteOpts {
  /** Override the cost-derived default timeout. */
  timeout?: number;
  /** Injection point for tests + the live adapter (set via setDefaultSender). */
  sender?: Sender;
}

let DEFAULT_SENDER: Sender | null = null;

/** Install the production (TCP) sender. Lazy on purpose so unit tests
 *  can use this module without importing tcp-client. */
export function setDefaultSender(s: Sender): void { DEFAULT_SENDER = s; }

export async function executeCommand<T = Record<string, unknown>>(
  cmd: string,
  params: Record<string, unknown> = {},
  opts: ExecuteOpts = {},
): Promise<T> {
  const sender = opts.sender ?? DEFAULT_SENDER;
  if (!sender) throw new UeToolError('No sender configured', { code: 'transport' });
  const timeout = opts.timeout ?? costToTimeoutMs(getToolMeta(cmd)?.cost);

  const attemptOnce = async (): Promise<TcpResponse> => sender(cmd, params, timeout);

  let resp: TcpResponse;
  try {
    resp = await attemptOnce();
  } catch (firstErr) {
    // Transport-level failure. Only retry when the command is idempotent:
    // non-idempotent ops (spawn, delete, create, …) must not execute twice.
    if (NON_IDEMPOTENT.has(cmd)) {
      const msg = (firstErr as Error)?.message ?? String(firstErr);
      throw new UeToolError(msg, { code: 'transport', uePayload: firstErr });
    }
    try {
      resp = await attemptOnce();
    } catch (secondErr) {
      const msg = (secondErr as Error)?.message ?? String(secondErr);
      throw new UeToolError(msg, { code: 'transport', uePayload: firstErr });
    }
  }

  if (resp.ok) return (resp.data ?? {}) as T;
  const code = mapUeCode(resp.code);
  throw new UeToolError(resp.error ?? 'unknown UE error', { code, uePayload: resp });
}

/** In-memory test adapter. Each registered command name maps to a function
 *  that returns the `(ok|error)` half of a `TcpResponse`. Send shape: arrow
 *  property so callers can destructure `exec.send` without losing `this`. */
export class InMemoryToolExecutor {
  private handlers = new Map<
    string,
    (params: Record<string, unknown>) => Omit<TcpResponse, 'id'> | Promise<Omit<TcpResponse, 'id'>>
  >();

  on(
    cmd: string,
    fn: (params: Record<string, unknown>) => Omit<TcpResponse, 'id'> | Promise<Omit<TcpResponse, 'id'>>,
  ): this {
    this.handlers.set(cmd, fn);
    return this;
  }

  send: Sender = async (cmd, params, _timeoutMs) => {
    const fn = this.handlers.get(cmd);
    if (!fn) throw new Error(`InMemoryToolExecutor: no handler registered for "${cmd}"`);
    const partial = await fn(params);
    return { id: 'inmem', ...partial };
  };
}

/** Install the live (TCP) sender. Call once at startup, before any handler
 *  invokes executeCommand. Lazy-imports tcp-client so this module can be
 *  unit-tested without the network. */
export async function installLiveSender(): Promise<void> {
  const { ensureConnected } = await import('../tcp-client.js');
  setDefaultSender(async (cmd, params, timeoutMs) => {
    const client = await ensureConnected();
    return client.send(cmd, params, timeoutMs);
  });
}
