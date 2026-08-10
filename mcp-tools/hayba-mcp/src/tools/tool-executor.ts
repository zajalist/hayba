import type { HaybaToolCost } from './hayba-tool-meta.js';
import type { TcpResponse } from '../tcp-client.js';
import { getToolMeta } from './tool-meta-registry.js';
import { isHeavyOp, HEAVY_OP_TIMEOUT_MS } from './heavy-ops.js';

export type UeToolErrorCode = 'transport' | 'timeout' | 'plan_gate' | 'tool_disabled' | 'ue_error' | 'editor_busy';

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
  low: 2_000,
  medium: 10_000,
  high: 120_000,
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
  'actor_spawn_from_asset',
  // Asset lifecycle
  'asset_delete',
  'asset_duplicate',
  'asset_import',
  'asset_rename',
  // asset_move moves FROM a path. If the first attempt lands but its reply is
  // lost, the retry looks for an asset that is no longer there and fails — so
  // the caller is told the move failed when it actually succeeded. Sat outside
  // this set while asset_rename and asset_delete beside it were protected.
  'asset_move',
  // Landscape
  'landscape_import',
  'landscape_add_layer',
  // Level authoring
  'level_create',
  // Blueprint authoring
  'blueprint_create',
  'blueprint_add_node',
  'blueprint_connect_nodes',
  'blueprint_set_pin_default',
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
  // PCG graph-edit destructive family (2026-07 postmortem §2a/§2b): removing a
  // node or cutting an edge is not safe to blind-retry (indices shift; a second
  // remove/disconnect fails because the target is already gone). pcg_layout /
  // pcg_list_pins / pcg_get_node are idempotent/read-only — intentionally absent.
  'pcg_remove_node',
  'pcg_disconnect',
  // ISM
  'ism_create_actor',
  'ism_clear_instances',
  // ISM add-element family
  'ism_add_instances',
  // Foliage
  'foliage_remove_instances',
  // Foliage-domain factory tools (Wave 3 Task 2) — see foliage-py-tools.ts
  // FOLIAGE_NON_IDEMPOTENT (asset-create / append / delete).
  'foliage_type_create',
  'foliage_add_instances',
  'foliage_scatter_paint',
  'foliage_remove_in_bounds',
  'foliage_clear_type',
  // Lighting-domain factory tools (Wave 3 Task 3) — see lighting-py-tools.ts
  // LIGHTING_NON_IDEMPOTENT (actor-create / multi-actor spawn).
  'light_spawn',
  'postprocess_spawn_volume',
  'sky_setup',
  // Spline
  'spline_create',
  // Sequencer (dormant satellite-plugin C++ command)
  'seq_create',
  // Sequencer factory tools (Phase 2 Wave 4) — mutating create/append; see
  // SEQUENCER_NON_IDEMPOTENT in sequencer/sequencer-py-tools.ts.
  'seq_new',
  'seq_bind_actor',
  'seq_track_add',
  'seq_transform_keyframe',
  'seq_camera_cut',
  // Niagara (dormant satellite-plugin C++ command)
  'niagara_spawn',
  // Niagara factory tools (Phase 2 Wave 4 Task 2) — spawn/place/create; see
  // NIAGARA_NON_IDEMPOTENT in niagara/niagara-py-tools.ts.
  'niagara_spawn_transient',
  'niagara_place_actor',
  'niagara_create_from_template',
  // Cumulative op: each call advances the sim forward, so a retry would
  // double-advance to a different end state — not retry-safe.
  'niagara_advance_simulation',
  // Water factory tools (Phase 2 Wave 4 Task 3) — spawn a persistent actor; see
  // WATER_NON_IDEMPOTENT in water/water-py-tools.ts.
  'water_body_ocean_create',
  'water_body_lake_create',
  'water_body_river_create',
  'water_zone_create',
  // MetaSound
  'metasound_create',
  'metasound_add_node',
  'metasound_connect',
  'metasound_set_input',
  // Audio runtime/asset operations that cannot be blind-retried. Set/save and
  // meter lifecycle are intentionally absent: those are set-to-value or
  // idempotent cleanup, while create/play/control/record can duplicate a live
  // voice, re-trigger a parameter, or consume the only recording buffer.
  'audio_asset_create',
  'audio_component_play',
  'audio_component_control',
  'audio_recording_start',
  'audio_recording_stop',
  // Saves packages and terminates the only UE transport; never retry after a
  // lost response because the first call may already have scheduled exit.
  'editor_save_all_and_quit',
  // A world click can select, move, attack or open game state. Never repeat it
  // after a lost response; the first dispatch may already have landed.
  'editor_pie_click_actor',
  // GAS
  'gas_create_ability',
  'gas_create_effect',
  // UI
  'ui_create_widget',
  'ui_set_widget_properties',
  'ui_mutate_tree',
  'ui_compile_widget',
  'ui_save_widget',
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

/**
 * Resolve the effective timeout for a command. Heavy, game-thread-blocking ops
 * (imports, level saves, PCG generate, asset re-index) get a dedicated,
 * generous `heavy` tier instead of their cost tier, so they don't pre-time-out
 * while UE is still legitimately working.
 */
export function resolveTimeoutMs(cmd: string): number {
  if (isHeavyOp(cmd)) return HEAVY_OP_TIMEOUT_MS;
  return costToTimeoutMs(getToolMeta(cmd)?.cost);
}

/**
 * Build the structured, actionable error thrown when a heavy op fails at the
 * transport layer (connection refused / reset / timeout). A heavy op that
 * drops the connection almost always means "editor is busy finishing the
 * operation on the game thread", NOT "editor crashed" — so the message steers
 * the caller to re-check status rather than assume a crash. When a live status
 * probe is reachable its process-up/down signal is folded in for accuracy.
 */
async function makeEditorBusyError(cmd: string, cause: unknown): Promise<UeToolError> {
  const causeMsg = (cause as Error)?.message ?? String(cause);
  let processHint = 'Re-check the editor with hayba_check_ue_status before retrying — do NOT auto-retry this op.';
  try {
    // Lazy import so this module stays unit-testable without the process probe.
    const { probeEditorProcess } = await import('./heavy-op-probe.js');
    const running = await probeEditorProcess();
    if (running === true) {
      processHint =
        'The UnrealEditor process is still running — it is almost certainly busy finishing this operation on the game thread (not crashed). Wait for it to settle, then re-check hayba_check_ue_status. Do NOT auto-retry.';
    } else if (running === false) {
      processHint =
        'No UnrealEditor process was detected — the editor may have exited/crashed during this operation. Verify with hayba_check_ue_status before retrying.';
    }
  } catch {
    // Probe unavailable — fall back to the generic hint.
  }
  return new UeToolError(
    `Heavy operation "${cmd}" failed at the transport layer (${causeMsg}). ` +
      `Heavy ops block the UE game thread and stop the plugin TCP port from accepting ` +
      `connections while they run. ${processHint}`,
    { code: 'editor_busy', uePayload: { cmd, cause: causeMsg, heavy: true } },
  );
}

export type Sender = (cmd: string, params: Record<string, unknown>, timeoutMs: number) => Promise<TcpResponse>;

export interface ExecuteOpts {
  /** Override the cost-derived default timeout. */
  timeout?: number;
  /** Injection point for tests + the live adapter (set via setDefaultSender). */
  sender?: Sender;
}

let DEFAULT_SENDER: Sender | null = null;

/** Install the production (TCP) sender. Lazy on purpose so unit tests
 *  can use this module without importing tcp-client. */
export function setDefaultSender(s: Sender): void {
  DEFAULT_SENDER = s;
}

export async function executeCommand<T = Record<string, unknown>>(
  cmd: string,
  params: Record<string, unknown> = {},
  opts: ExecuteOpts = {},
): Promise<T> {
  const sender = opts.sender ?? DEFAULT_SENDER;
  if (!sender) throw new UeToolError('No sender configured', { code: 'transport' });
  const heavy = isHeavyOp(cmd);
  const timeout = opts.timeout ?? resolveTimeoutMs(cmd);

  const attemptOnce = async (): Promise<TcpResponse> => sender(cmd, params, timeout);

  let resp: TcpResponse;
  try {
    resp = await attemptOnce();
  } catch (firstErr) {
    // Heavy ops NEVER retry: they block the game thread and are effectively
    // non-idempotent, so re-firing into a busy editor compounds the stall.
    // Throw a structured "editor busy" error steering the caller to re-check
    // status rather than assume a crash.
    if (heavy) {
      throw await makeEditorBusyError(cmd, firstErr);
    }
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
