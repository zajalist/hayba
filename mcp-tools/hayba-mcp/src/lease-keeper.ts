// Keeps this process's editor leases alive (lease_renew heartbeat).
//
// A lease the editor grants lapses after its TTL unless renewed. An agent that
// is busy thinking should not lose its world lease to that, so every lease
// acquired through the lease_acquire tool is tracked here, by its lease_id,
// and renewed at a third of its TTL. A renew the editor refuses (lease
// expired, released, or dropped with its connection) stops tracking and
// reports the loss; a transport failure keeps trying, because the next tick
// may reconnect. Only usable lease_ids are tracked: a redaction marker or a
// pre-lease_id handle could never be renewed (postmortem I-5).
//
// Kept apart from tcp-client so it is unit-testable with a fake sender and
// fake timers. See docs/adr/0010-multi-agent-editor-leases.md.

import { executeCommand, UeToolError, type Sender } from './tools/tool-executor.js';
import { isUsableLeaseId } from './lease-id.js';

export { isUsableLeaseId };

export type TimerHandle = { unref?: () => void };

export interface LeaseKeeperOptions {
  /** Defaults to the tool-executor's installed sender. */
  sender?: Sender;
  setInterval?: (fn: () => void, ms: number) => TimerHandle;
  clearInterval?: (handle: TimerHandle) => void;
  /** Called once when the editor refuses a renew; the lease is gone. */
  onLost?: (leaseId: string, reason: string) => void;
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

  /** Start (or restart) the heartbeat for a granted lease. False, and nothing
   *  tracked, when `leaseId` is not a usable lease_id. */
  track(leaseId: string, ttlS: number): boolean {
    if (!isUsableLeaseId(leaseId)) return false;
    this.untrack(leaseId);
    const timer = this.opts.setInterval(() => {
      void this.renewNow(leaseId);
    }, renewIntervalMs(ttlS));
    this.held.set(leaseId, { ttlS, timer });
    return true;
  }

  untrack(leaseId: string): void {
    const tracked = this.held.get(leaseId);
    if (!tracked) return;
    this.opts.clearInterval(tracked.timer);
    this.held.delete(leaseId);
  }

  heldLeaseIds(): string[] {
    return [...this.held.keys()];
  }

  /** One renew. Returns true while the lease is still held. */
  async renewNow(leaseId: string): Promise<boolean> {
    const tracked = this.held.get(leaseId);
    if (!tracked) return false;
    try {
      await executeCommand('lease_renew', { lease_id: leaseId, ttl_s: tracked.ttlS }, { sender: this.opts.sender });
      return true;
    } catch (err) {
      if (err instanceof UeToolError && err.code === 'transport') {
        // The editor may be busy or reconnecting; the next tick retries. If the
        // connection really closed, the editor already released bound leases
        // and the next renew is refused, which lands in the branch below.
        return true;
      }
      const reason = err instanceof Error ? err.message : String(err);
      this.untrack(leaseId);
      this.opts.onLost(leaseId, reason);
      return false;
    }
  }

  stopAll(): void {
    for (const leaseId of [...this.held.keys()]) this.untrack(leaseId);
  }
}

let keeper: LeaseKeeper | null = null;

/** Process-wide keeper used by the lease_* tools. */
export function getLeaseKeeper(): LeaseKeeper {
  if (!keeper) {
    keeper = new LeaseKeeper({
      onLost: (leaseId, reason) => console.error(`[hayba] lease ${leaseId} lost: ${reason}`),
    });
  }
  return keeper;
}

/** Reset the singleton - for tests only. */
export function _resetLeaseKeeperForTesting(): void {
  keeper?.stopAll();
  keeper = null;
}
