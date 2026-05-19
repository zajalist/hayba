import type { HaybaToolCost } from './hayba-tool-meta.js';

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
