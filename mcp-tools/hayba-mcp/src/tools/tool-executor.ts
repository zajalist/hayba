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
  const resp = await sender(cmd, params, timeout);
  if (resp.ok) return (resp.data ?? {}) as T;
  throw new UeToolError(resp.error ?? 'unknown UE error', { code: 'ue_error', uePayload: resp });
}
