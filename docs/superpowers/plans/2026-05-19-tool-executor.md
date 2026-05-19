# ToolExecutor Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ad-hoc `ensureConnected + client.send + bespoke error handling` boilerplate in ~40 MCP tool handlers with a single deep seam (`executeCommand`) that owns transport, retry, timeout-from-cost, and typed errors.

**Architecture:** A thin TCP-envelope module (`tool-executor.ts`) wraps the existing `UETcpClient`. Handlers call `await executeCommand(cmd, params, opts?)` and either receive the UE `data` object or catch a `UeToolError` whose `code` field discriminates the failure mode. A separate name → meta registry supplies the per-command `cost` so the executor picks a sensible default timeout without each handler having to specify one. An in-memory adapter implements the same interface for unit tests, so handler tests no longer need a live UE on `:52342`. C++ side gets a one-line addition: rejection responses optionally carry a `code` string.

**Tech Stack:** TypeScript 5.6 (strict mode, ESM, `.js` extensions on imports), `vitest` for tests, the existing `UETcpClient` in `src/tcp-client.ts`, `FHaybaMCPSettings` + `HaybaMCPCommandHandler.cpp` on the C++ side.

**Locked design** (from `mcp-tools/hayba-mcp/CONTEXT.md`):
- `executeCommand(cmd, params, opts?) → Promise<data>` — resolves with UE `data` on success, throws `UeToolError` on failure.
- `UeToolError extends Error { code: "transport" | "timeout" | "plan_gate" | "tool_disabled" | "ue_error"; uePayload?: unknown }`
- Default timeout from cost: `low=2s, medium=10s, high=60s`. Unknown command → `medium`.
- Auto-retry **once** only on `"transport"` failures.
- C++ envelope: optional `code` field on rejection responses (`{ok:false, error, code?}`); only `plan_gate` and `tool_disabled` paths set it today.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `mcp-tools/hayba-mcp/src/tools/tool-executor.ts` | **create** | `UeToolError`, `executeCommand`, `InMemoryToolExecutor`, `costToTimeoutMs`. |
| `mcp-tools/hayba-mcp/src/tools/tool-executor.test.ts` | **create** | vitest unit tests, uses `InMemoryToolExecutor`. |
| `mcp-tools/hayba-mcp/src/tools/tool-meta-registry.ts` | **create** | `registerToolMeta(name, meta)` / `getToolMeta(name)` — flat name→meta lookup populated at registration. |
| `mcp-tools/hayba-mcp/src/tools/tool-meta-registry.test.ts` | **create** | vitest for the registry. |
| `mcp-tools/hayba-mcp/src/tools/index.ts` | **modify** | After each `server.tool(...)` call, also call `registerToolMeta(name, meta)`. No handler logic changes here. |
| `mcp-tools/hayba-mcp/src/tcp-client.ts` | **modify** | Add `code?: string` to `TcpResponse`. One additive field. |
| `D:/UnrealEngine/geoforge/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCommandHandler.cpp` | **modify** | Two response sites (plan-gate, tool-disabled) gain `"code": "plan_gate"` / `"tool_disabled"` field. |
| Each `mcp-tools/hayba-mcp/src/tools/**/*.ts` handler (~40 files) | **modify** | Replace `ensureConnected + client.send + manual error check` with one `executeCommand(cmd, params)` call. |
| `mcp-tools/hayba-mcp/CHANGELOG.md` | **modify** | Document the seam + the wire-compat `code` field. |
| `mcp-tools/hayba-mcp/CONTEXT.md` | **modify** | Drop "(planned)" once landed. |

---

## Task 1: `UeToolError` class

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/tool-executor.ts`
- Test: `mcp-tools/hayba-mcp/src/tools/tool-executor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// mcp-tools/hayba-mcp/src/tools/tool-executor.test.ts
import { describe, it, expect } from 'vitest';
import { UeToolError } from './tool-executor.js';

describe('UeToolError', () => {
  it('carries a code discriminator and optional uePayload', () => {
    const e = new UeToolError('boom', { code: 'plan_gate', uePayload: { reason: 'destructive' } });
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(UeToolError);
    expect(e.message).toBe('boom');
    expect(e.code).toBe('plan_gate');
    expect(e.uePayload).toEqual({ reason: 'destructive' });
    expect(e.name).toBe('UeToolError');
  });

  it('defaults uePayload to undefined', () => {
    const e = new UeToolError('x', { code: 'ue_error' });
    expect(e.uePayload).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```
cd mcp-tools/hayba-mcp && npx vitest run src/tools/tool-executor.test.ts
```
Expected: `Cannot find module './tool-executor.js'`.

- [ ] **Step 3: Implement `UeToolError` in `tool-executor.ts`**

```ts
// mcp-tools/hayba-mcp/src/tools/tool-executor.ts
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
```

- [ ] **Step 4: Run to verify it passes**

```
cd mcp-tools/hayba-mcp && npx vitest run src/tools/tool-executor.test.ts
```
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/tool-executor.ts mcp-tools/hayba-mcp/src/tools/tool-executor.test.ts
git commit -m "feat(hayba-mcp): UeToolError with code discriminator"
```

---

## Task 2: `costToTimeoutMs` helper

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/tools/tool-executor.ts`
- Test: `mcp-tools/hayba-mcp/src/tools/tool-executor.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

```ts
// append to tool-executor.test.ts
import { costToTimeoutMs } from './tool-executor.js';

describe('costToTimeoutMs', () => {
  it('maps low/medium/high to 2s/10s/60s', () => {
    expect(costToTimeoutMs('low')).toBe(2_000);
    expect(costToTimeoutMs('medium')).toBe(10_000);
    expect(costToTimeoutMs('high')).toBe(60_000);
  });
  it('defaults to medium for unknown cost', () => {
    expect(costToTimeoutMs(undefined)).toBe(10_000);
    // @ts-expect-error — runtime safety for bad input
    expect(costToTimeoutMs('garbage')).toBe(10_000);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/tools/tool-executor.test.ts`
Expected: 2 new tests fail with `costToTimeoutMs is not a function`.

- [ ] **Step 3: Implement**

```ts
// append to tool-executor.ts
import type { HaybaToolCost } from './hayba-tool-meta.js';

const COST_TIMEOUTS_MS: Record<HaybaToolCost, number> = {
  low:    2_000,
  medium: 10_000,
  high:   60_000,
};

export function costToTimeoutMs(cost: HaybaToolCost | undefined): number {
  if (cost && cost in COST_TIMEOUTS_MS) return COST_TIMEOUTS_MS[cost];
  return COST_TIMEOUTS_MS.medium;
}
```

- [ ] **Step 4: Run to verify pass**

`npx vitest run src/tools/tool-executor.test.ts` → 4 passed.

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/tool-executor.ts mcp-tools/hayba-mcp/src/tools/tool-executor.test.ts
git commit -m "feat(hayba-mcp): costToTimeoutMs (2s/10s/60s)"
```

---

## Task 3: Tool meta registry

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/tool-meta-registry.ts`
- Test: `mcp-tools/hayba-mcp/src/tools/tool-meta-registry.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// mcp-tools/hayba-mcp/src/tools/tool-meta-registry.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { registerToolMeta, getToolMeta, resetToolMetaRegistry } from './tool-meta-registry.js';
import type { HaybaToolMeta } from './hayba-tool-meta.js';

const META: HaybaToolMeta = { cost: 'medium', effects: [], when: 'x', not_when: 'y' };

describe('tool-meta-registry', () => {
  beforeEach(() => resetToolMetaRegistry());

  it('stores and retrieves meta by command name', () => {
    registerToolMeta('actor_spawn', { ...META, cost: 'high' });
    expect(getToolMeta('actor_spawn')?.cost).toBe('high');
  });

  it('returns undefined for unknown command', () => {
    expect(getToolMeta('not_registered')).toBeUndefined();
  });

  it('last write wins on duplicate registration', () => {
    registerToolMeta('x', { ...META, cost: 'low' });
    registerToolMeta('x', { ...META, cost: 'high' });
    expect(getToolMeta('x')?.cost).toBe('high');
  });
});
```

- [ ] **Step 2: Run to verify failure**

`npx vitest run src/tools/tool-meta-registry.test.ts` — fails on missing module.

- [ ] **Step 3: Implement**

```ts
// mcp-tools/hayba-mcp/src/tools/tool-meta-registry.ts
import type { HaybaToolMeta } from './hayba-tool-meta.js';

const REGISTRY = new Map<string, HaybaToolMeta>();

export function registerToolMeta(name: string, meta: HaybaToolMeta): void {
  REGISTRY.set(name, meta);
}

export function getToolMeta(name: string): HaybaToolMeta | undefined {
  return REGISTRY.get(name);
}

/** Test-only — clears the registry between specs. */
export function resetToolMetaRegistry(): void {
  REGISTRY.clear();
}
```

- [ ] **Step 4: Run to verify pass**

`npx vitest run src/tools/tool-meta-registry.test.ts` → 3 passed.

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/tool-meta-registry.ts mcp-tools/hayba-mcp/src/tools/tool-meta-registry.test.ts
git commit -m "feat(hayba-mcp): flat tool-meta registry (name -> HaybaToolMeta)"
```

---

## Task 4: `code` field on `TcpResponse`

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/tcp-client.ts:11-16`

- [ ] **Step 1: Add the optional field**

Find this block:
```ts
export interface TcpResponse {
  id: string;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}
```

Replace with:
```ts
export interface TcpResponse {
  id: string;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
  /** Optional machine-readable failure code from the UE side. Set on plan-gate
   *  and tool-disabled rejections so the TS ToolExecutor can map them onto a
   *  UeToolError code without string-matching UE's `error` text. */
  code?: string;
}
```

- [ ] **Step 2: tsc check**

```
cd mcp-tools/hayba-mcp && npx tsc --noEmit
```
Expected: exit 0. No callers break because the field is optional and only added.

- [ ] **Step 3: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tcp-client.ts
git commit -m "feat(hayba-mcp): TcpResponse gains optional 'code' field (wire-compat)"
```

---

## Task 5: `executeCommand` happy path with an injected sender

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/tools/tool-executor.ts`
- Test: `mcp-tools/hayba-mcp/src/tools/tool-executor.test.ts` (append)

The executor needs a `sender` function it can call. The default (production) sender wraps `ensureConnected + client.send`; tests inject a fake. This is the "two adapters" pattern.

- [ ] **Step 1: Write failing test for the happy path**

```ts
// append to tool-executor.test.ts
import { executeCommand, type Sender } from './tool-executor.js';
import type { TcpResponse } from '../tcp-client.js';

const okSender: Sender = async (cmd, params, _timeout) => ({
  id: 't',
  ok: true,
  data: { echoed: { cmd, params } },
});

describe('executeCommand — happy path', () => {
  it('returns the response.data object on ok:true', async () => {
    const data = await executeCommand('actor_list', { tag: 'x' }, { sender: okSender });
    expect(data).toEqual({ echoed: { cmd: 'actor_list', params: { tag: 'x' } } });
  });

  it('passes timeout-from-cost to the sender when meta is registered', async () => {
    const seen: number[] = [];
    const spy: Sender = async (_c, _p, t) => { seen.push(t); return { id: 't', ok: true, data: {} }; };
    const { registerToolMeta, resetToolMetaRegistry } = await import('./tool-meta-registry.js');
    resetToolMetaRegistry();
    registerToolMeta('build_project', { cost: 'high', effects: [], when: '', not_when: '' });
    await executeCommand('build_project', {}, { sender: spy });
    expect(seen[0]).toBe(60_000); // high
  });

  it('defaults timeout to medium (10s) when meta is missing', async () => {
    const { resetToolMetaRegistry } = await import('./tool-meta-registry.js');
    resetToolMetaRegistry();
    const seen: number[] = [];
    const spy: Sender = async (_c, _p, t) => { seen.push(t); return { id: 't', ok: true, data: {} }; };
    await executeCommand('unknown', {}, { sender: spy });
    expect(seen[0]).toBe(10_000);
  });

  it('honors an explicit opts.timeout override', async () => {
    const seen: number[] = [];
    const spy: Sender = async (_c, _p, t) => { seen.push(t); return { id: 't', ok: true, data: {} }; };
    await executeCommand('x', {}, { sender: spy, timeout: 1234 });
    expect(seen[0]).toBe(1234);
  });
});
```

- [ ] **Step 2: Run to verify failure**

`npx vitest run src/tools/tool-executor.test.ts` — new tests fail (`executeCommand` undefined).

- [ ] **Step 3: Implement happy path**

```ts
// append to tool-executor.ts
import type { TcpResponse } from '../tcp-client.js';
import { getToolMeta } from './tool-meta-registry.js';

export type Sender = (
  cmd: string,
  params: Record<string, unknown>,
  timeoutMs: number,
) => Promise<TcpResponse>;

export interface ExecuteOpts {
  /** Override the cost-derived default. */
  timeout?: number;
  /** Injection point for tests + the live adapter. */
  sender?: Sender;
}

/** Default sender: lazy-imports ensureConnected so this module can be unit-tested
 *  without a TCP client. The live binding is in `defaultLiveSender` (Task 9). */
let DEFAULT_SENDER: Sender | null = null;
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
```

- [ ] **Step 4: Run to verify pass**

`npx vitest run src/tools/tool-executor.test.ts` → 8 passed (4 from earlier + 4 new).

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/tool-executor.ts mcp-tools/hayba-mcp/src/tools/tool-executor.test.ts
git commit -m "feat(hayba-mcp): executeCommand happy path with injectable Sender"
```

---

## Task 6: Map `code` discriminator from UE responses

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/tools/tool-executor.ts`
- Test: `mcp-tools/hayba-mcp/src/tools/tool-executor.test.ts` (append)

- [ ] **Step 1: Write failing tests**

```ts
// append to tool-executor.test.ts
describe('executeCommand — error code mapping', () => {
  it('throws UeToolError with code "plan_gate" when UE response carries that code', async () => {
    const sender: Sender = async () => ({ id: 't', ok: false, error: 'needs approval', code: 'plan_gate' });
    await expect(executeCommand('actor_delete', {}, { sender }))
      .rejects.toMatchObject({ name: 'UeToolError', code: 'plan_gate', message: 'needs approval' });
  });

  it('throws UeToolError with code "tool_disabled" likewise', async () => {
    const sender: Sender = async () => ({ id: 't', ok: false, error: 'off', code: 'tool_disabled' });
    await expect(executeCommand('x', {}, { sender }))
      .rejects.toMatchObject({ code: 'tool_disabled' });
  });

  it('defaults to "ue_error" when response has ok:false but no code', async () => {
    const sender: Sender = async () => ({ id: 't', ok: false, error: 'something' });
    await expect(executeCommand('x', {}, { sender }))
      .rejects.toMatchObject({ code: 'ue_error', message: 'something' });
  });

  it('passes through unrecognised codes as "ue_error" but preserves UE payload', async () => {
    const sender: Sender = async () => ({ id: 't', ok: false, error: 'novel', code: 'something_new' });
    try {
      await executeCommand('x', {}, { sender });
      throw new Error('should have thrown');
    } catch (e: unknown) {
      const u = e as InstanceType<typeof UeToolError>;
      expect(u.code).toBe('ue_error');
      expect((u.uePayload as TcpResponse).code).toBe('something_new');
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

`npx vitest run src/tools/tool-executor.test.ts` — new tests fail (mapping not implemented).

- [ ] **Step 3: Update `executeCommand`**

In `tool-executor.ts`, replace the error-throwing line in `executeCommand` with:

```ts
  if (resp.ok) return (resp.data ?? {}) as T;
  const code = mapUeCode(resp.code);
  throw new UeToolError(resp.error ?? 'unknown UE error', { code, uePayload: resp });
```

And add the helper near the top of the file:

```ts
const KNOWN_CODES = new Set<UeToolErrorCode>(['plan_gate', 'tool_disabled']);
function mapUeCode(raw: string | undefined): UeToolErrorCode {
  if (raw && KNOWN_CODES.has(raw as UeToolErrorCode)) return raw as UeToolErrorCode;
  return 'ue_error';
}
```

- [ ] **Step 4: Run tests**

`npx vitest run src/tools/tool-executor.test.ts` → 12 passed.

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/tool-executor.ts mcp-tools/hayba-mcp/src/tools/tool-executor.test.ts
git commit -m "feat(hayba-mcp): map UE response.code to UeToolError.code (plan_gate, tool_disabled, ue_error)"
```

---

## Task 7: Auto-retry once on transport failure

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/tools/tool-executor.ts`
- Test: `mcp-tools/hayba-mcp/src/tools/tool-executor.test.ts` (append)

The contract: if the sender *throws* (transport-level), retry once. UE-returned errors (`ok:false`) do NOT retry.

- [ ] **Step 1: Write failing tests**

```ts
// append to tool-executor.test.ts
describe('executeCommand — transport retry', () => {
  it('retries once when sender throws (transport failure)', async () => {
    let attempts = 0;
    const flaky: Sender = async () => {
      attempts++;
      if (attempts === 1) throw new Error('ECONNRESET');
      return { id: 't', ok: true, data: { attempts } };
    };
    const data = await executeCommand<{ attempts: number }>('x', {}, { sender: flaky });
    expect(data.attempts).toBe(2);
  });

  it('throws UeToolError with code "transport" after retry budget exhausted', async () => {
    const always: Sender = async () => { throw new Error('ECONNRESET'); };
    await expect(executeCommand('x', {}, { sender: always }))
      .rejects.toMatchObject({ name: 'UeToolError', code: 'transport' });
  });

  it('does NOT retry on UE error responses (ok:false)', async () => {
    let attempts = 0;
    const sender: Sender = async () => {
      attempts++;
      return { id: 't', ok: false, error: 'no' };
    };
    await expect(executeCommand('x', {}, { sender })).rejects.toMatchObject({ code: 'ue_error' });
    expect(attempts).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

`npx vitest run src/tools/tool-executor.test.ts` — new tests fail.

- [ ] **Step 3: Implement retry**

Replace the body of `executeCommand` with:

```ts
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
```

- [ ] **Step 4: Run tests**

`npx vitest run src/tools/tool-executor.test.ts` → 15 passed.

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/tool-executor.ts mcp-tools/hayba-mcp/src/tools/tool-executor.test.ts
git commit -m "feat(hayba-mcp): executeCommand auto-retries once on transport failure"
```

---

## Task 8: Live sender wiring + `InMemoryToolExecutor` helper

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/tools/tool-executor.ts`
- Test: `mcp-tools/hayba-mcp/src/tools/tool-executor.test.ts` (append)

We need the **live** binding (so `executeCommand` works without callers passing `sender`) AND an **in-memory adapter** (so handler tests can register canned responses).

- [ ] **Step 1: Write failing test for `InMemoryToolExecutor`**

```ts
// append to tool-executor.test.ts
import { InMemoryToolExecutor } from './tool-executor.js';

describe('InMemoryToolExecutor', () => {
  it('returns canned ok responses', async () => {
    const exec = new InMemoryToolExecutor();
    exec.on('actor_list', () => ({ ok: true, data: { actors: [], count: 0 } }));
    const data = await executeCommand<{ count: number }>('actor_list', {}, { sender: exec.send });
    expect(data.count).toBe(0);
  });
  it('returns canned ok:false with code', async () => {
    const exec = new InMemoryToolExecutor();
    exec.on('x', () => ({ ok: false, error: 'nope', code: 'plan_gate' }));
    await expect(executeCommand('x', {}, { sender: exec.send }))
      .rejects.toMatchObject({ code: 'plan_gate' });
  });
  it('throws "no handler registered" when called for an unregistered command', async () => {
    const exec = new InMemoryToolExecutor();
    await expect(executeCommand('missing', {}, { sender: exec.send }))
      .rejects.toMatchObject({ code: 'transport' }); // throws-from-sender => mapped to transport
  });
});
```

- [ ] **Step 2: Run to verify failure**

`npx vitest run src/tools/tool-executor.test.ts` — fails (`InMemoryToolExecutor` undefined).

- [ ] **Step 3: Implement**

Append to `tool-executor.ts`:

```ts
/** In-memory adapter for tests. Each registered command name maps to a
 *  function that returns the `(ok|error)` half of a TcpResponse. */
export class InMemoryToolExecutor {
  private handlers = new Map<string, (params: Record<string, unknown>) => Omit<TcpResponse, 'id'> | Promise<Omit<TcpResponse, 'id'>>>();
  on(cmd: string, fn: (params: Record<string, unknown>) => Omit<TcpResponse, 'id'> | Promise<Omit<TcpResponse, 'id'>>): this {
    this.handlers.set(cmd, fn);
    return this;
  }
  // Arrow so callers can destructure `exec.send` without losing `this`.
  send: Sender = async (cmd, params, _timeoutMs) => {
    const fn = this.handlers.get(cmd);
    if (!fn) throw new Error(`InMemoryToolExecutor: no handler registered for "${cmd}"`);
    const partial = await fn(params);
    return { id: 'inmem', ...partial };
  };
}
```

And add the live binding (with a lazy import so this module remains unit-testable in isolation):

```ts
/** Install the live (TCP) sender. Call this once at startup, before any
 *  handler invokes executeCommand. Implemented as a function so tests don't
 *  pay the cost of importing tcp-client when only the executor is under test. */
export async function installLiveSender(): Promise<void> {
  const { ensureConnected } = await import('../tcp-client.js');
  setDefaultSender(async (cmd, params, timeoutMs) => {
    const client = await ensureConnected();
    return client.send(cmd, params, timeoutMs);
  });
}
```

- [ ] **Step 4: Run tests**

`npx vitest run src/tools/tool-executor.test.ts` → 18 passed.

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/tool-executor.ts mcp-tools/hayba-mcp/src/tools/tool-executor.test.ts
git commit -m "feat(hayba-mcp): InMemoryToolExecutor + installLiveSender (two real adapters)"
```

---

## Task 9: Wire meta registry + live sender at startup

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/tools/index.ts`

`server.tool(name, ...)` is called ~88 times in `index.ts`. Each call site that has a corresponding `meta` import should register it. We do this by adding **one call** to a small wrapper helper that the migrated registrations will use.

- [ ] **Step 1: Add a `register` helper near the top of `registerTools`**

Insert near the top of the `registerTools(server, session)` function body in `mcp-tools/hayba-mcp/src/tools/index.ts`:

```ts
  // Local helper: pushes the tool's meta into the registry so the ToolExecutor
  // can look up cost by command name. Keeps registration sites one-liner.
  const remember = (name: string, meta: HaybaToolMeta | undefined): void => {
    if (meta) registerToolMeta(name, meta);
  };
```

And at the top of the file (with the other imports):

```ts
import { installLiveSender } from './tool-executor.js';
import { registerToolMeta } from './tool-meta-registry.js';
```

- [ ] **Step 2: Install live sender at the start of `registerTools`**

Inside `registerTools`, before any `server.tool(...)` calls, add:

```ts
  // Wire the live (TCP) sender so handlers calling executeCommand reach UE.
  // Fire-and-forget — sender becomes available before the first tool call
  // because the agent host hands tools to the user after registration.
  void installLiveSender();
```

- [ ] **Step 3: For now, only register meta for the tools that already export it**

Run a one-time helper script (no commit) to verify how many `server.tool` calls have matching `meta` exports — should match. We *do not* migrate handlers yet; this task only adds the registry-population infrastructure.

For each registration site that imports a `meta`, add `remember('<name>', meta);` immediately after the `server.tool(...)` block. Mechanical; one line per tool. Skip tools without a `meta` export (Code Mode meta-tools sometimes don't).

- [ ] **Step 4: tsc + vitest**

```
cd mcp-tools/hayba-mcp && npx tsc --noEmit && npx vitest run src/
```
Expected: 0 errors, all `src/*.test.ts` pass.

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/index.ts
git commit -m "feat(hayba-mcp): populate tool-meta registry + install live sender at startup"
```

---

## Task 10: C++ envelope — set `code` on plan-gate and tool-disabled rejections

**Files:**
- Modify: `D:/UnrealEngine/geoforge/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCommandHandler.cpp` (outside this git repo)
- Modify: `mcp-tools/hayba-mcp/CHANGELOG.md`

The C++ rejection paths today produce JSON like `{ok:false, error:"..."}`. We add `code` to two sites.

- [ ] **Step 1: Find the two rejection paths**

```
grep -n "bPlanApproved\|tool_disabled\|tool disabled\|plan mode" D:/UnrealEngine/geoforge/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCommandHandler.cpp
```

Identify the JSON-building lines around `bPlanApproved == false` (plan-gate) and the disabled-tool check.

- [ ] **Step 2: Add the `code` field at the plan-gate rejection site**

In the JSON builder near the plan-gate reject path, add a `"code"` field beside `"error"`:

```cpp
// Existing:
//   Response->SetBoolField(TEXT("ok"), false);
//   Response->SetStringField(TEXT("error"), TEXT("Plan Mode is enabled and this plan is not approved..."));
// Add:
Response->SetStringField(TEXT("code"), TEXT("plan_gate"));
```

- [ ] **Step 3: Same at the tool-disabled rejection site**

```cpp
Response->SetStringField(TEXT("code"), TEXT("tool_disabled"));
```

- [ ] **Step 4: Update CHANGELOG**

In `mcp-tools/hayba-mcp/CHANGELOG.md` under `### Added`, append:

```markdown
- TCP response envelope: optional `code` field for machine-readable rejection
  reasons. Only set on plan-gate and tool-disabled paths today. Older TS
  clients ignore the field (wire-compatible). The TS ToolExecutor maps
  `code` onto `UeToolError.code` so callers can branch without
  string-matching error text. **Requires a plugin recompile.**
```

- [ ] **Step 5: Trigger Live Coding**

In a Claude session with hayba MCP connected:
```ts
mcp__hayba-toolkit__python_run({ script: `unreal.SystemLibrary.execute_console_command(unreal.EditorLevelLibrary.get_editor_world(), 'LiveCoding.Compile')` })
```

Wait for "Live coding succeeded" in `editor_stream_log` filter `LiveCoding`.

- [ ] **Step 6: Commit (CHANGELOG only — the .cpp lives outside the repo)**

```bash
git add mcp-tools/hayba-mcp/CHANGELOG.md
git commit -m "feat(hayba-mcp): TCP envelope gains optional 'code' field on rejections (C++ side, recompile required)"
```

---

## Task 11: Pilot handler migration — `actor_list`

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/tools/actor/actor-list.ts`

`actor_list` is read-only, called frequently, and has a small handler — perfect pilot. We prove the pattern end-to-end before touching the rest.

- [ ] **Step 1: Read the current handler**

```
cat mcp-tools/hayba-mcp/src/tools/actor/actor-list.ts
```

It should look roughly like:
```ts
import { ensureConnected } from '../../tcp-client.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = { cost: 'low', effects: [], when: '...', not_when: '...' };

export async function handleActorList(params: { class_filter?: string; tag?: string }) {
  const client = await ensureConnected();
  const resp = await client.send('actor_list', params);
  if (!resp.ok) throw new Error(resp.error || 'actor_list failed');
  return resp.data;
}
```

- [ ] **Step 2: Rewrite to use `executeCommand`**

```ts
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = { cost: 'low', effects: [], when: '...', not_when: '...' };

export async function handleActorList(params: { class_filter?: string; tag?: string }) {
  return executeCommand('actor_list', params);
}
```

Two-line body. The error path is now uniformly `UeToolError` for any caller that catches.

- [ ] **Step 3: tsc check**

```
cd mcp-tools/hayba-mcp && npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 4: Live verification**

If a Claude session is connected to UE, call `mcp__hayba-toolkit__actor_list` and verify the response shape unchanged. A passing call here demonstrates the seam works end-to-end.

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/actor/actor-list.ts
git commit -m "refactor(hayba-mcp): migrate actor_list handler to executeCommand (pilot)"
```

---

## Task 12: Bulk handler migration

**Files:**
- Modify: every `mcp-tools/hayba-mcp/src/tools/**/*.ts` handler that today calls `ensureConnected + client.send`.

Each handler is migrated the same way as the pilot. Group by directory and commit per group so a regression is bisectable.

- [ ] **Step 1: Migrate `actor/*` (3 remaining)**

Apply the Task 11 transformation to:
- `mcp-tools/hayba-mcp/src/tools/actor/actor-spawn.ts`
- `mcp-tools/hayba-mcp/src/tools/actor/actor-delete.ts`
- `mcp-tools/hayba-mcp/src/tools/actor/actor-transform.ts`

After each, `npx tsc --noEmit`.

Commit:
```bash
git add mcp-tools/hayba-mcp/src/tools/actor/
git commit -m "refactor(hayba-mcp): migrate actor/* handlers to executeCommand"
```

- [ ] **Step 2: Migrate `editor/*`**

Same transformation for every file under `mcp-tools/hayba-mcp/src/tools/editor/`. Commit:
```bash
git add mcp-tools/hayba-mcp/src/tools/editor/
git commit -m "refactor(hayba-mcp): migrate editor/* handlers to executeCommand"
```

- [ ] **Step 3: Migrate top-level handler files (`create-pcg-graph.ts`, `execute-pcg-graph.ts`, `validate-pcg-graph.ts`, `export-pcg-graph.ts`, `list-pcg-assets.ts`, `format-graph-topology.ts`, `validate-attribute-flow.ts`, `match-pin-names.ts`, `query-pcgex-docs.ts`, `get-node-details.ts`, `search-node-catalog.ts`, `propose-plan.ts`, `mark-plan-step.ts`, and any others using `client.send`)**

Migrate each. Commit per logical group (PCG, Plan-Mode, search) so each commit is < ~5 files.

- [ ] **Step 4: Migrate remaining handlers**

Sweep with `grep -rl "client.send\|ensureConnected" mcp-tools/hayba-mcp/src/tools` and migrate any leftover. Commit:
```bash
git add mcp-tools/hayba-mcp/src/tools/
git commit -m "refactor(hayba-mcp): migrate remaining handlers to executeCommand"
```

- [ ] **Step 5: Verify zero direct callers remain**

```
grep -rn "client.send\|ensureConnected" mcp-tools/hayba-mcp/src/tools --include=*.ts
```
Expected: only `tool-executor.ts` (the live sender wiring) references `ensureConnected`. No handler should import `client` directly.

---

## Task 13: Final verify + CHANGELOG entry

**Files:**
- Modify: `mcp-tools/hayba-mcp/CHANGELOG.md`
- Modify: `mcp-tools/hayba-mcp/CONTEXT.md`

- [ ] **Step 1: Full local test suite**

```
cd mcp-tools/hayba-mcp && npx tsc --noEmit && npx vitest run src/
```
Expected: 0 type errors. All `src/*.test.ts` pass. The known-broken `tests/gaea/*` and `tests/tools/hayba-*` failures pre-date this work — verify their count is unchanged.

- [ ] **Step 2: Live smoke test against UE**

Restart the agent host (so the MCP server reloads with the new build). Call `mcp__hayba-toolkit__actor_list` and `mcp__hayba-toolkit__hayba_check_ue_status`. Both return clean JSON.

- [ ] **Step 3: CHANGELOG entry**

Append to `mcp-tools/hayba-mcp/CHANGELOG.md` under `### Added`:

```markdown
- **ToolExecutor seam** (`src/tools/tool-executor.ts`): a single `executeCommand(cmd, params, opts?)` API behind which lives connection management, 1× auto-retry on transport failure, timeout-from-cost (low=2s / med=10s / high=60s), and a uniform `UeToolError` with `code` discriminator (`transport | timeout | plan_gate | tool_disabled | ue_error`). ~40 handlers shed their `ensureConnected + client.send + bespoke error throw` boilerplate. Two adapters ship: the live (TCP) sender used in production, and an `InMemoryToolExecutor` that lets handler tests run without a live UE on `:52342`.
```

- [ ] **Step 4: Update CONTEXT.md**

Remove the "(planned)" marker on the `ToolExecutor` entry — it's now real.

```
sed -i 's| (planned)||' mcp-tools/hayba-mcp/CONTEXT.md
```

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/CHANGELOG.md mcp-tools/hayba-mcp/CONTEXT.md
git commit -m "docs(hayba-mcp): ToolExecutor landed; update CHANGELOG + CONTEXT"
```

Then invoke `superpowers:finishing-a-development-branch` to merge.

---

## Self-Review

**1. Spec coverage:**
- Width=thin → Task 1–8 build only the TCP envelope (no Zod parsing, no gate logic).
- Failure scope (4 modes) → transport retry (Task 7), cost-default timeout (Task 5), typed UE error (Task 5), plan-gate distinct (Task 6).
- Cost source = B (lookup) → Task 3 (registry), Task 5 (lookup at call), Task 9 (populate at registration).
- Error shape (one class + code) → Task 1.
- Wire change (C++ `code` field) → Task 4 (TS type), Task 10 (C++ implementation).
- Two adapters → Task 8 (`InMemoryToolExecutor` + `installLiveSender`).
- Handler migration → Task 11 pilot, Task 12 bulk, Task 13 verify-clean.

**2. Placeholder scan:** Every step has concrete code or exact commands. No "TBD" or "handle edge cases". Task 12's grouping is enumerated by directory, not as "similar to pilot."

**3. Type consistency:** `Sender` signature (`(cmd, params, timeoutMs) => Promise<TcpResponse>`) is identical in Tasks 5, 7, 8. `UeToolError.code` matches `UeToolErrorCode` union across Tasks 1, 5, 6. `getToolMeta` returns `HaybaToolMeta | undefined` in Task 3 and is called the same way in Task 5. `installLiveSender` is async in Task 8 and called as `void installLiveSender()` in Task 9. Consistent.
