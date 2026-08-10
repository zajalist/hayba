import { createHash } from 'node:crypto';

export interface IdempotencyLedgerOptions {
  /** Completed receipts live in memory only and expire after this interval. */
  completedTtlMs?: number;
  /** Maximum replayable receipts. In-flight work is never evicted to meet it. */
  maxCompleted?: number;
  /** Fail closed instead of admitting unbounded distinct in-flight mutations. */
  maxInFlight?: number;
  now?: () => number;
}

export interface IdempotentRequest {
  /** Stable identity supplied by an authenticated transport, never request args. */
  principal: string;
  tool: string;
  key: string;
  /** Canonical, validated tool parameters (including dispatch-affecting fields). */
  request: unknown;
  /** Cancels only this waiter. Shared work continues for other retries. */
  waitSignal?: AbortSignal;
}

export type IdempotencyErrorCode =
  | 'idempotency_invalid'
  | 'idempotency_conflict'
  | 'idempotency_capacity'
  | 'idempotency_wait_cancelled';

/** Safe to return to a caller: it contains no principal, key, params, or fingerprint. */
export class IdempotencyLedgerError extends Error {
  constructor(
    public readonly code: IdempotencyErrorCode,
    message: string,
    /** One-way slot identifier, useful for correlation without revealing the key. */
    public readonly reference?: string,
  ) {
    super(message);
    this.name = 'IdempotencyLedgerError';
  }
}

interface InFlightEntry<T> {
  state: 'in_flight';
  fingerprint: string;
  promise: Promise<T>;
}

interface CompletedEntry<T> {
  state: 'completed';
  fingerprint: string;
  receipt: T;
  completedAt: number;
  sequence: number;
}

type Entry<T> = InFlightEntry<T> | CompletedEntry<T>;

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_COMPLETED = 1_024;
const DEFAULT_MAX_IN_FLIGHT = 128;
const MAX_IDENTITY_BYTES = 4_096;
const MAX_KEY_BYTES = 512;
const MAX_CANONICAL_REQUEST_BYTES = 2 * 1024 * 1024;

/**
 * Process-local idempotency for mutation dispatch.
 *
 * Slots are SHA-256(principal, tool, key); only the digest is retained. A slot
 * either joins one in-flight promise or replays one verified completed receipt.
 * Rejections and unverified/unknown outcomes remove the slot so they never pose
 * as success. This is intentionally not a durable, cross-process journal.
 */
export class IdempotencyLedger {
  private readonly entries = new Map<string, Entry<unknown>>();
  private readonly completedTtlMs: number;
  private readonly maxCompleted: number;
  private readonly maxInFlight: number;
  private readonly now: () => number;
  private sequence = 0;

  constructor(options: IdempotencyLedgerOptions = {}) {
    this.completedTtlMs = positiveInteger(options.completedTtlMs ?? DEFAULT_TTL_MS, 'completedTtlMs');
    this.maxCompleted = positiveInteger(options.maxCompleted ?? DEFAULT_MAX_COMPLETED, 'maxCompleted');
    this.maxInFlight = positiveInteger(options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT, 'maxInFlight');
    this.now = options.now ?? Date.now;
  }

  async run<T>(
    request: IdempotentRequest,
    operation: () => Promise<T>,
    isVerifiedCompleted: (receipt: T) => boolean,
  ): Promise<T> {
    validateBoundedString(request.principal, 'authenticated principal', MAX_IDENTITY_BYTES);
    validateBoundedString(request.tool, 'tool name', MAX_IDENTITY_BYTES);
    validateBoundedString(request.key, 'idempotency key', MAX_KEY_BYTES);

    const canonical = canonicalJson(request.request);
    if (Buffer.byteLength(canonical, 'utf8') > MAX_CANONICAL_REQUEST_BYTES) {
      throw new IdempotencyLedgerError('idempotency_invalid', 'The canonical request is too large for idempotency tracking.');
    }

    const slot = digestParts([request.principal, request.tool, request.key]);
    const reference = slot.slice(0, 16);
    const fingerprint = digestParts([request.tool, canonical]);
    const now = this.now();
    this.purgeExpiredCompleted(now);

    const existing = this.entries.get(slot) as Entry<T> | undefined;
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new IdempotencyLedgerError(
          'idempotency_conflict',
          'This idempotency key was already used for a different request.',
          reference,
        );
      }
      if (existing.state === 'in_flight') {
        return await waitWithoutCancellingSharedWork(existing.promise, request.waitSignal);
      }
      return cloneReceipt(existing.receipt);
    }

    if (this.inFlightCount() >= this.maxInFlight) {
      throw new IdempotencyLedgerError(
        'idempotency_capacity',
        'The idempotency ledger is at its in-flight limit; retry this request later with the same key.',
      );
    }

    let entry!: InFlightEntry<T>;
    const shared = Promise.resolve()
      .then(operation)
      .then((receipt) => {
        // A classifier or clone failure must not turn successful tool work into
        // a failed call. It merely makes the outcome non-replayable.
        try {
          if (isVerifiedCompleted(receipt)) {
            const snapshot = cloneReceipt(receipt);
            if (this.entries.get(slot) === entry) {
              this.entries.set(slot, {
                state: 'completed',
                fingerprint,
                receipt: snapshot,
                completedAt: this.now(),
                sequence: ++this.sequence,
              });
              this.evictCompletedOverCapacity();
            }
          } else if (this.entries.get(slot) === entry) {
            this.entries.delete(slot);
          }
        } catch {
          if (this.entries.get(slot) === entry) this.entries.delete(slot);
        }
        return receipt;
      }, (error: unknown) => {
        if (this.entries.get(slot) === entry) this.entries.delete(slot);
        throw error;
      });

    entry = { state: 'in_flight', fingerprint, promise: shared };
    this.entries.set(slot, entry as InFlightEntry<unknown>);
    return await waitWithoutCancellingSharedWork(shared, request.waitSignal);
  }

  /** Aggregate diagnostics only: no slot IDs, principals, keys, or fingerprints. */
  diagnostics(): { scope: 'process_lifetime'; in_flight: number; completed: number; completed_ttl_ms: number } {
    this.purgeExpiredCompleted(this.now());
    let inFlight = 0;
    let completed = 0;
    for (const entry of this.entries.values()) {
      if (entry.state === 'in_flight') inFlight += 1;
      else completed += 1;
    }
    return {
      scope: 'process_lifetime',
      in_flight: inFlight,
      completed,
      completed_ttl_ms: this.completedTtlMs,
    };
  }

  private inFlightCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.state === 'in_flight') count += 1;
    return count;
  }

  private purgeExpiredCompleted(now: number): void {
    for (const [slot, entry] of this.entries) {
      if (entry.state === 'completed' && now - entry.completedAt >= this.completedTtlMs) {
        this.entries.delete(slot);
      }
    }
  }

  private evictCompletedOverCapacity(): void {
    const completed = [...this.entries.entries()]
      .filter((pair): pair is [string, CompletedEntry<unknown>] => pair[1].state === 'completed')
      .sort((a, b) => a[1].sequence - b[1].sequence);
    for (let i = 0; i < completed.length - this.maxCompleted; i += 1) {
      this.entries.delete(completed[i]![0]);
    }
  }
}

/**
 * Cache only #370's strongest terminal state. Quiet verified successes may
 * omit advisory presentation, so explicit readback/save evidence is accepted
 * only when no advisory or contradictory failure evidence exists.
 */
export function isVerifiedSuccessReceipt(receipt: unknown): boolean {
  const evidence = collectEvidence(receipt);
  const contradiction = evidence.contradiction
    || (evidence.dirty && evidence.explicitVerification);
  if (evidence.advisoryStates.length > 0) {
    return evidence.advisoryStates.every((state) => state === 'success') && !contradiction;
  }
  return evidence.explicitVerification && !contradiction;
}

interface ReceiptEvidence {
  advisoryStates: string[];
  explicitVerification: boolean;
  contradiction: boolean;
  dirty: boolean;
}

function collectEvidence(value: unknown, depth = 0, evidence?: ReceiptEvidence): ReceiptEvidence {
  const out = evidence ?? {
    advisoryStates: [],
    explicitVerification: false,
    contradiction: false,
    dirty: false,
  };
  if (depth > 4 || !value || typeof value !== 'object') return out;
  const object = value as Record<string, unknown>;
  const advisory = object.advisory;
  if (advisory && typeof advisory === 'object') {
    const state = (advisory as Record<string, unknown>).state;
    if (typeof state === 'string') out.advisoryStates.push(state);
  }

  // A successful Promise is not enough: TS handlers can resolve an explicit
  // `{ok:false}` or a failed save. Any such evidence vetoes replay even if a
  // different field claims verification.
  if (
    object.ok === false
    || object.success === false
    || object.saved === false
    || object.save_verified === false
    || object.valid === false
  ) {
    out.contradiction = true;
  }
  const failed = object.failed;
  if (typeof failed === 'number' && Number.isFinite(failed) && failed > 0) {
    out.contradiction = true;
  }
  if (hasNonEmptyFailure(object.error) || hasNonEmptyFailure(object.errors)) {
    out.contradiction = true;
  }
  if (object.dirty === true) out.dirty = true;

  for (const key of ['readback_verified', 'verified', 'compiled_clean', 'saved', 'save_verified']) {
    if (object[key] === false) out.contradiction = true;
    if (object[key] === true) out.explicitVerification = true;
  }

  for (const key of ['data', 'result']) {
    collectEvidence(object[key], depth + 1, out);
  }
  if (Array.isArray(object.content)) {
    for (const block of object.content) {
      if (!block || typeof block !== 'object') continue;
      const text = (block as Record<string, unknown>).text;
      if (typeof text !== 'string') continue;
      try {
        collectEvidence(JSON.parse(text), depth + 1, out);
      } catch {
        // Non-JSON content cannot establish a verified terminal receipt.
      }
    }
  }
  return out;
}

function hasNonEmptyFailure(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return value === true || (typeof value === 'number' && Number.isFinite(value) && value > 0);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function validateBoundedString(value: string, name: string, maxBytes: number): void {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new IdempotencyLedgerError('idempotency_invalid', `The ${name} is missing or too large.`);
  }
}

function digestParts(parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new IdempotencyLedgerError('idempotency_invalid', 'The request contains a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item ?? null)).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(',')}}`;
  }
  throw new IdempotencyLedgerError('idempotency_invalid', 'The request contains a value that cannot be represented as JSON.');
}

function cloneReceipt<T>(receipt: T): T {
  return structuredClone(receipt);
}

function waitWithoutCancellingSharedWork<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new IdempotencyLedgerError(
      'idempotency_wait_cancelled',
      'This waiter was cancelled; the keyed operation may still be in flight. Retry with the same key.',
    ));
  }
  return new Promise<T>((resolve, reject) => {
    const cancelled = () => {
      cleanup();
      reject(new IdempotencyLedgerError(
        'idempotency_wait_cancelled',
        'This waiter was cancelled; the keyed operation may still be in flight. Retry with the same key.',
      ));
    };
    const cleanup = () => signal.removeEventListener('abort', cancelled);
    signal.addEventListener('abort', cancelled, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
}
