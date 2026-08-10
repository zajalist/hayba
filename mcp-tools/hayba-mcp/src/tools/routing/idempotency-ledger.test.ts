import { describe, expect, it, vi } from 'vitest';
import {
  IdempotencyLedger,
  IdempotencyLedgerError,
  isVerifiedSuccessReceipt,
} from './idempotency-ledger.js';

const verified = { advisory: { state: 'success' }, receipt: 'r-1' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function request(overrides: Partial<{ principal: string; tool: string; key: string; request: unknown }> = {}) {
  return {
    principal: 'authenticated-client-a',
    tool: 'actor_spawn',
    key: 'retry-key-1',
    request: { args: { label: 'One', location: [1, 2, 3] }, via: 'ts' },
    ...overrides,
  };
}

describe('IdempotencyLedger', () => {
  it('joins simultaneous canonical duplicates and executes the mutation once', async () => {
    const ledger = new IdempotencyLedger();
    const gate = deferred<typeof verified>();
    const operation = vi.fn(() => gate.promise);

    const first = ledger.run(request(), operation, isVerifiedSuccessReceipt);
    const second = ledger.run(request({
      request: { via: 'ts', args: { location: [1, 2, 3], label: 'One' } },
    }), operation, isVerifiedSuccessReceipt);
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    gate.resolve(verified);

    await expect(first).resolves.toEqual(verified);
    await expect(second).resolves.toEqual(verified);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('scopes identical tool+key pairs by authenticated principal', async () => {
    const ledger = new IdempotencyLedger();
    let calls = 0;
    await ledger.run(request(), async () => ({ ...verified, calls: ++calls }), isVerifiedSuccessReceipt);
    const other = await ledger.run(
      request({ principal: 'authenticated-client-b' }),
      async () => ({ ...verified, calls: ++calls }),
      isVerifiedSuccessReceipt,
    );
    expect(other.calls).toBe(2);
  });

  it('fails closed when the same slot carries changed params without revealing either request', async () => {
    const ledger = new IdempotencyLedger();
    await ledger.run(request(), async () => verified, isVerifiedSuccessReceipt);

    const conflict = await ledger.run(
      request({ request: { args: { label: 'SECRET-CHANGED' }, via: 'ts' } }),
      async () => verified,
      isVerifiedSuccessReceipt,
    ).catch((error: unknown) => error);

    expect(conflict).toBeInstanceOf(IdempotencyLedgerError);
    if (!(conflict instanceof IdempotencyLedgerError)) throw new Error('expected ledger conflict');
    expect(conflict.code).toBe('idempotency_conflict');
    const safe = JSON.stringify({ error: conflict, diagnostics: ledger.diagnostics() });
    expect(safe).not.toContain('retry-key-1');
    expect(safe).not.toContain('SECRET-CHANGED');
    expect(safe).not.toContain('authenticated-client-a');
    expect(conflict.reference).toMatch(/^[a-f0-9]{16}$/);
  });

  it('rejects a changed request while the original slot is still in flight', async () => {
    const ledger = new IdempotencyLedger();
    const gate = deferred<typeof verified>();
    const original = ledger.run(request(), () => gate.promise, isVerifiedSuccessReceipt);
    const changed = ledger.run(
      request({ request: { via: 'ue_legacy', args: { label: 'One', location: [1, 2, 3] } } }),
      async () => verified,
      isVerifiedSuccessReceipt,
    );
    await expect(changed).rejects.toMatchObject({ code: 'idempotency_conflict' });
    gate.resolve(verified);
    await expect(original).resolves.toEqual(verified);
  });

  it('replays only a verified success and protects the stored receipt from caller mutation', async () => {
    const ledger = new IdempotencyLedger();
    const operation = vi.fn(async () => ({ advisory: { state: 'success' }, nested: { count: 1 } }));
    const first = await ledger.run(request(), operation, isVerifiedSuccessReceipt);
    first.nested.count = 99;

    const replay = await ledger.run(request(), operation, isVerifiedSuccessReceipt);
    expect(replay.nested.count).toBe(1);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(ledger.diagnostics()).toMatchObject({ scope: 'process_lifetime', completed: 1, in_flight: 0 });
  });

  it.each([
    { receipt: { readback_verified: true }, label: 'readback' },
    { receipt: { data: { verified: true } }, label: 'nested verification' },
    { receipt: { result: { compiled_clean: true } }, label: 'clean compile' },
    { receipt: { content: [{ type: 'text', text: JSON.stringify({ saved: true }) }] }, label: 'saved MCP content' },
  ])('replays a quiet verified success with explicit $label evidence', async ({ receipt }) => {
    const ledger = new IdempotencyLedger();
    const operation = vi.fn(async () => receipt);
    await ledger.run(request(), operation, isVerifiedSuccessReceipt);
    await ledger.run(request(), operation, isVerifiedSuccessReceipt);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not treat a bare ok:true as verified completion', async () => {
    const ledger = new IdempotencyLedger();
    const operation = vi.fn(async () => ({ ok: true }));
    await ledger.run(request(), operation, isVerifiedSuccessReceipt);
    await ledger.run(request(), operation, isVerifiedSuccessReceipt);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not cache saved:false even when another field claims verification', async () => {
    const ledger = new IdempotencyLedger();
    const operation = vi.fn(async () => ({ verified: true, saved: false }));
    await ledger.run(request(), operation, isVerifiedSuccessReceipt);
    await ledger.run(request(), operation, isVerifiedSuccessReceipt);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it.each([
    { label: 'failed count', receipt: { saved: true, failed: 1 } },
    { label: 'error string', receipt: { verified: true, error: 'write rejected' } },
    { label: 'errors array in a nested result', receipt: { result: { readback_verified: true, errors: ['mismatch'] } } },
    { label: 'failed save verification', receipt: { saved: true, save_verified: false } },
    { label: 'invalid result', receipt: { compiled_clean: true, valid: false } },
    { label: 'still-dirty save/readback', receipt: { saved: true, dirty: true } },
  ])('does not cache quiet verification contradicted by $label', async ({ receipt }) => {
    const ledger = new IdempotencyLedger();
    const operation = vi.fn(async () => receipt);
    await ledger.run(request(), operation, isVerifiedSuccessReceipt);
    await ledger.run(request(), operation, isVerifiedSuccessReceipt);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not treat warnings or empty error containers as failure evidence', async () => {
    const ledger = new IdempotencyLedger();
    const operation = vi.fn(async () => ({
      readback_verified: true,
      warnings: ['a useful warning'],
      error: '',
      errors: [],
    }));
    await ledger.run(request(), operation, isVerifiedSuccessReceipt);
    await ledger.run(request(), operation, isVerifiedSuccessReceipt);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('lets a non-success advisory veto otherwise-positive readback evidence', () => {
    expect(isVerifiedSuccessReceipt({
      advisory: { state: 'success_needs_verification' },
      readback_verified: true,
      saved: true,
    })).toBe(false);
  });

  it.each([
    'success_needs_verification',
    'partial_success',
    'input_rejected',
    'policy_blocked',
    'retryable_failure',
    'unknown_outcome',
    'session_suspect',
    'fatal_error',
  ])('does not cache the advisory state %s', async (state) => {
    const ledger = new IdempotencyLedger();
    const operation = vi.fn(async () => ({ advisory: { state } }));
    await ledger.run(request(), operation, isVerifiedSuccessReceipt);
    await ledger.run(request(), operation, isVerifiedSuccessReceipt);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(ledger.diagnostics().completed).toBe(0);
  });

  it('removes rejected operations so the same key is retryable', async () => {
    const ledger = new IdempotencyLedger();
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('transport outcome unknown'))
      .mockResolvedValueOnce(verified);
    await expect(ledger.run(request(), operation, isVerifiedSuccessReceipt)).rejects.toThrow('outcome unknown');
    await expect(ledger.run(request(), operation, isVerifiedSuccessReceipt)).resolves.toEqual(verified);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('never evicts in-flight work at capacity, while same-slot retries still join it', async () => {
    const ledger = new IdempotencyLedger({ maxInFlight: 1 });
    const gate = deferred<typeof verified>();
    const operation = vi.fn(() => gate.promise);
    const first = ledger.run(request(), operation, isVerifiedSuccessReceipt);
    const joined = ledger.run(request(), operation, isVerifiedSuccessReceipt);

    const rejected = ledger.run(
      request({ key: 'different-key' }),
      async () => verified,
      isVerifiedSuccessReceipt,
    );
    await expect(rejected).rejects.toMatchObject({ code: 'idempotency_capacity' });
    expect(ledger.diagnostics().in_flight).toBe(1);
    expect(operation).toHaveBeenCalledTimes(1);

    gate.resolve(verified);
    await Promise.all([first, joined]);
    await expect(ledger.run(
      request({ key: 'different-key' }),
      async () => verified,
      isVerifiedSuccessReceipt,
    )).resolves.toEqual(verified);
  });

  it('cancels one waiter without abandoning shared work or allowing a duplicate', async () => {
    const ledger = new IdempotencyLedger();
    const gate = deferred<typeof verified>();
    const controller = new AbortController();
    const operation = vi.fn(() => gate.promise);
    const cancelled = ledger.run(
      { ...request(), waitSignal: controller.signal },
      operation,
      isVerifiedSuccessReceipt,
    );
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'idempotency_wait_cancelled' });

    const retry = ledger.run(request(), operation, isVerifiedSuccessReceipt);
    expect(operation).toHaveBeenCalledTimes(1);
    gate.resolve(verified);
    await expect(retry).resolves.toEqual(verified);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('expires completed receipts and re-executes after the process-local TTL', async () => {
    let now = 1_000;
    const ledger = new IdempotencyLedger({ completedTtlMs: 100, now: () => now });
    const operation = vi.fn(async () => verified);
    await ledger.run(request(), operation, isVerifiedSuccessReceipt);
    now = 1_099;
    await ledger.run(request(), operation, isVerifiedSuccessReceipt);
    expect(operation).toHaveBeenCalledTimes(1);
    now = 1_100;
    await ledger.run(request(), operation, isVerifiedSuccessReceipt);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('bounds completed receipts by evicting the oldest completed slot only', async () => {
    const ledger = new IdempotencyLedger({ maxCompleted: 1 });
    const operation = vi.fn(async () => verified);
    await ledger.run(request({ key: 'old' }), operation, isVerifiedSuccessReceipt);
    await ledger.run(request({ key: 'new' }), operation, isVerifiedSuccessReceipt);
    expect(ledger.diagnostics().completed).toBe(1);
    await ledger.run(request({ key: 'old' }), operation, isVerifiedSuccessReceipt);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('recognises verified success in a standard MCP text envelope, but not malformed content', () => {
    expect(isVerifiedSuccessReceipt({
      content: [{ type: 'text', text: JSON.stringify({ data: { advisory: { state: 'success' } } }) }],
    })).toBe(true);
    expect(isVerifiedSuccessReceipt({ content: [{ type: 'text', text: '{not-json' }] })).toBe(false);
  });
});
