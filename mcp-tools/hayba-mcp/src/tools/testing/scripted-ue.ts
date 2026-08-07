// A scripted Unreal, for testing the code that talks to it.
//
// The ToolExecutor seam has had a test adapter since it was built, but almost
// nothing used it: 105 files call executeCommand and 22 had tests. The result
// was that the least-tested code in the repo was also the only code that can
// change a user's project, and every bug in it had to be found by opening the
// editor — which is exactly what is unavailable when the editor is busy, broken,
// or mid-rebuild.
//
// This wraps InMemoryToolExecutor with the FAILURE MODES that actually occur,
// because a scripted engine that only ever succeeds tests the happy path and
// nothing else. The interesting ones are not transport errors — those throw
// loudly and were never the problem. The interesting one is `silentlySucceeds`:
// UE answering "ok" for work it did not do. Every silent-success bug found in
// this toolkit had that shape.

import { InMemoryToolExecutor, setDefaultSender } from '../tool-executor.js';

export interface RecordedCall {
  cmd: string;
  params: Record<string, unknown>;
}

export class ScriptedUe {
  private readonly exec = new InMemoryToolExecutor();

  /** Every command the code under test sent, in order. */
  readonly calls: RecordedCall[] = [];

  private record(cmd: string, params: Record<string, unknown>): void {
    this.calls.push({ cmd, params });
  }

  /** UE handles the command and returns data. */
  replies(cmd: string, data: Record<string, unknown> | ((p: Record<string, unknown>) => Record<string, unknown>)): this {
    this.exec.on(cmd, (params) => {
      this.record(cmd, params);
      return { ok: true, data: typeof data === 'function' ? data(params) : data };
    });
    return this;
  }

  /**
   * UE answers `{ok: true}` and nothing else.
   *
   * The most dangerous response in the system: indistinguishable from success,
   * and produced by a handler that dropped the property, ignored the key, or
   * never dirtied the asset. Code under test must not report this as done.
   */
  silentlySucceeds(cmd: string): this {
    this.exec.on(cmd, (params) => {
      this.record(cmd, params);
      return { ok: true, data: {} };
    });
    return this;
  }

  /**
   * UE applies some keys and ignores others.
   *
   * Models the real UMG/PCG behaviour where an unknown or misspelled property
   * name is skipped silently. `applied` is echoed back; everything else is
   * reported in `rejected_keys` only if the caller asked for it — pass
   * `{ report: false }` to model a handler that drops them without saying so.
   */
  partiallyApplies(cmd: string, applied: string[], opts: { report?: boolean } = {}): this {
    this.exec.on(cmd, (params) => {
      this.record(cmd, params);
      const props = (params.properties ?? params) as Record<string, unknown>;
      const changed = Object.keys(props).filter((k) => applied.includes(k));
      const rejected = Object.keys(props).filter((k) => !applied.includes(k));
      return {
        ok: true,
        data: opts.report === false ? { ok: true } : { changed_keys: changed, rejected_keys: rejected },
      };
    });
    return this;
  }

  /** UE refuses the command — a real error with a code the executor maps. */
  fails(cmd: string, error: string, code = 'ue_error'): this {
    this.exec.on(cmd, (params) => {
      this.record(cmd, params);
      return { ok: false, error, code };
    });
    return this;
  }

  /**
   * UE refuses the command AND returns structured data explaining why.
   *
   * Not a variant for completeness: the sandbox tier that tells python_run's
   * caller which setting to change arrives this way, in `data` on a non-ok
   * response. Code that reads only the error string loses it, and the loss is
   * invisible — the tool still fails, just unhelpfully.
   */
  failsWithData(cmd: string, error: string, data: Record<string, unknown>): this {
    this.exec.on(cmd, (params) => {
      this.record(cmd, params);
      return { ok: false, error, data };
    });
    return this;
  }

  /** The transport drops — models the editor being busy or gone. */
  disconnects(cmd: string): this {
    this.exec.on(cmd, (params) => {
      this.record(cmd, params);
      throw new Error('socket closed');
    });
    return this;
  }

  /** Params of the single call to `cmd`, asserting exactly one was made. */
  paramsFor(cmd: string): Record<string, unknown> {
    const hits = this.calls.filter((c) => c.cmd === cmd);
    if (hits.length !== 1) {
      throw new Error(`expected exactly one "${cmd}" call, saw ${hits.length}: [${this.calls.map((c) => c.cmd).join(', ')}]`);
    }
    return hits[0]!.params;
  }

  /** Route executeCommand here for the duration of a test. */
  install(): this {
    setDefaultSender(this.exec.send);
    return this;
  }

  /**
   * Point the seam at a sender that fails loudly.
   *
   * Deliberately not a no-op: leaving a live sender installed after a test lets
   * the next test pass for the wrong reason.
   */
  restore(): void {
    setDefaultSender(async (cmd) => {
      throw new Error(`ScriptedUe was uninstalled, but "${cmd}" was still sent`);
    });
  }
}

/** Convenience: a scripted UE installed for the duration of one test. */
export function scriptedUe(): ScriptedUe {
  return new ScriptedUe().install();
}
