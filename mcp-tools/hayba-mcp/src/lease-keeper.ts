// Keeps this process's editor leases alive (lease_renew heartbeat).
//
// A lease the editor grants lapses after its TTL unless renewed. An agent that
// is busy thinking should not lose its world lease to that, so every lease
// acquired through the lease_acquire tool is tracked here and renewed at a
// third of its TTL. A renew the editor refuses (lease expired, released, or
// dropped with its connection) stops tracking and reports the loss; a
// transport failure keeps trying, because the next tick may reconnect.
//
// Kept apart from tcp-client so it is unit-testable with a fake sender and
// fake timers. See docs/adr/0010-multi-agent-editor-leases.md.

import { executeCommand, UeToolError, type Sender } from './tools/tool-executor.js';

export type TimerHandle = { unref?: () => void };

export interface LeaseKeeperOptions {
  /** Defaults to the tool-executor's installed sender. */
  sender?: Sender;
  setInterval?: (fn: () => void, ms: number) => TimerHandle;
  clearInterval?: (handle: TimerHandle) => void;
  /** Called once when the editor refuses a renew; the lease is gone. */
  onLost?: (token: string, reason: string) => void;
}

interface Tracked {
  ttlS: number;
  timer: TimerHandle;
}

/** Renew at a third of the TTL, never more often than once a second. */
export function renewIntervalMs(ttlS: number): number {
  return Math.max(1_000, Math.floor((ttlS * 1_000) / 3));
}

export class LeaseKeeper {
  private readonly held = new Map<string, Tracked>();
  private readonly opts: Required<Omit<LeaseKeeperOptions, 'sender'>> & { sender?: Sender };

  constructor(opts: LeaseKeeperOptions = {}) {
    this.opts = {
      sender: opts.sender,
      setInterval:
        opts.setInterval ??
        ((fn, ms) => {
          const handle = setInterval(fn, ms);
          // A heartbeat must never keep the MCP server process alive by itself.
          handle.unref?.();
          return handle;
        }),
      clearInterval: opts.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>)),
      onLost: opts.onLost ?? (() => {}),
    };
  }

  /** Start (or restart) the heartbeat for a granted lease. */
  track(token: string, ttlS: number): void {
    this.untrack(token);
    const timer = this.opts.setInterval(() => {
      void this.renewNow(token);
    }, renewIntervalMs(ttlS));
    this.held.set(token, { ttlS, timer });
  }

  untrack(token: string): void {
    const tracked = this.held.get(token);
    if (!tracked) return;
    this.opts.clearInterval(tracked.timer);
    this.held.delete(token);
  }

  heldTokens(): string[] {
    return [...this.held.keys()];
  }

  /** One renew. Returns true while the lease is still held. */
  async renewNow(token: string): Promise<boolean> {
    const tracked = this.held.get(token);
    if (!tracked) return false;
    try {
      await executeCommand('lease_renew', { token, ttl_s: tracked.ttlS }, { sender: this.opts.sender });
      return true;
    } catch (err) {
      if (err instanceof UeToolError && err.code === 'transport') {
        // The editor may be busy or reconnecting; the next tick retries. If the
        // connection really closed, the editor already released bound leases
        // and the next renew is refused, which lands in the branch below.
        return true;
      }
      const reason = err instanceof Error ? err.message : String(err);
      this.untrack(token);
      this.opts.onLost(token, reason);
      return false;
    }
  }

  stopAll(): void {
    for (const token of [...this.held.keys()]) this.untrack(token);
  }
}

let keeper: LeaseKeeper | null = null;

/** Process-wide keeper used by the lease_* tools. */
export function getLeaseKeeper(): LeaseKeeper {
  if (!keeper) {
    keeper = new LeaseKeeper({
      onLost: (token, reason) => console.error(`[hayba] lease ${token} lost: ${reason}`),
    });
  }
  return keeper;
}

/** Reset the singleton - for tests only. */
export function _resetLeaseKeeperForTesting(): void {
  keeper?.stopAll();
  keeper = null;
}
