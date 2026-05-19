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

const COST_TIMEOUTS_MS: Record<HaybaToolCost, number> = {
  low:    2_000,
  medium: 10_000,
  high:   60_000,
};

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
    // transport-level failure — one retry
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
