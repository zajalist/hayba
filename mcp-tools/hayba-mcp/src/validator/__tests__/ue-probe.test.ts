import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { probeCount, type UeProbe } from '../ue-probe.js';

let dir: string;
const FILE = 'count.json';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ue-probe-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A probe that writes `payload` to the scratch file and prints `stdout`. */
function probeThat(opts: { payload?: unknown; stdout?: string; ok?: boolean }): UeProbe {
  return async () => {
    if (opts.payload !== undefined) {
      writeFileSync(join(dir, FILE), JSON.stringify(opts.payload));
    }
    return { ok: opts.ok ?? true, stdout: opts.stdout ?? '' };
  };
}

const run = (probe: UeProbe | null) =>
  probeCount(probe, { script: 'noop', fileName: FILE, key: 'total', scratchDir: dir, timeoutMs: 100 });

describe('probeCount', () => {
  it('reads the count from the scratch file', async () => {
    expect(await run(probeThat({ payload: { total: 7 } }))).toBe(7);
  });

  it('reads a legitimate zero rather than treating it as absent', async () => {
    // The whole point of the rules that use this: 0 is the finding-worthy
    // value, so it must survive every falsy-coercion path.
    expect(await run(probeThat({ payload: { total: 0 } }))).toBe(0);
  });

  it('deletes the scratch file so a later run cannot read a stale count', async () => {
    await run(probeThat({ payload: { total: 3 } }));
    expect(existsSync(join(dir, FILE))).toBe(false);
  });

  it('falls back to the printed value when no file was written', async () => {
    expect(await run(probeThat({ stdout: '{"total": 12}' }))).toBe(12);
  });

  it('falls back to stdout when the file is unparseable, and still unlinks it', async () => {
    const probe: UeProbe = async () => {
      writeFileSync(join(dir, FILE), 'not json{');
      return { ok: true, stdout: '{"total": 5}' };
    };
    expect(await run(probe)).toBe(5);
    expect(existsSync(join(dir, FILE))).toBe(false);
  });

  it('returns null — NOT 0 — when there is no probe at all', async () => {
    // A rule that read this as 0 would report "produced zero instances" every
    // time the editor was unreachable.
    expect(await run(null)).toBeNull();
  });

  it('returns null when the probe call failed', async () => {
    expect(await run(probeThat({ ok: false, stdout: '{"total": 9}' }))).toBeNull();
  });

  it('returns null when neither the file nor stdout carries the key', async () => {
    expect(await run(probeThat({ payload: { somethingElse: 1 }, stdout: 'done' }))).toBeNull();
  });
});
