import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './index.js';
import { EXIT_OK, EXIT_SPEC_ERROR, EXIT_STEP_FAILED, EXIT_UE_UNREACHABLE } from './exit-codes.js';
import type { RunnerDeps } from './runner.js';

// Real temp files, but a fully injected RunnerDeps — no socket, no spawn.
// Reading a spec file off disk is the CLI's actual, in-scope job; the UE
// seam (checkReachable/execute) is what gets faked here.

let dir: string;
const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hayba-cli-test-'));
  errSpy.mockClear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeSpec(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf-8');
  return p;
}

const okDeps = (execute = vi.fn(async () => ({ ok: true }))): RunnerDeps => ({
  checkReachable: async () => ({ reachable: true, detail: '' }),
  execute,
});

describe('hayba-cli main()', () => {
  it('exits EXIT_SPEC_ERROR with no arguments', async () => {
    const code = await main([], okDeps());
    expect(code).toBe(EXIT_SPEC_ERROR);
  });

  it('exits 0 and prints usage on --help', async () => {
    const code = await main(['--help'], okDeps());
    expect(code).toBe(0);
  });

  it('exits EXIT_SPEC_ERROR when the spec file does not exist', async () => {
    const code = await main([join(dir, 'nope.json')], okDeps());
    expect(code).toBe(EXIT_SPEC_ERROR);
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/cannot read spec file/));
  });

  it('exits EXIT_SPEC_ERROR when the spec file is malformed', async () => {
    const p = writeSpec('bad.json', '{ this is not valid json');
    const code = await main([p], okDeps());
    expect(code).toBe(EXIT_SPEC_ERROR);
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/malformed spec/));
  });

  it('exits EXIT_SPEC_ERROR when steps is missing', async () => {
    const p = writeSpec('empty.json', '{}');
    const code = await main([p], okDeps());
    expect(code).toBe(EXIT_SPEC_ERROR);
  });

  it('exits EXIT_UE_UNREACHABLE and never executes any step when UE is unreachable', async () => {
    const p = writeSpec('spec.json', JSON.stringify({ steps: [{ cmd: 'ping' }] }));
    const execute = vi.fn();
    const code = await main([p], {
      checkReachable: async () => ({ reachable: false, detail: 'port 52342 answered nothing' }),
      execute,
    });
    expect(code).toBe(EXIT_UE_UNREACHABLE);
    expect(execute).not.toHaveBeenCalled();
  });

  it('exits EXIT_STEP_FAILED when a step fails', async () => {
    const p = writeSpec('spec.json', JSON.stringify({ steps: [{ cmd: 'boom' }] }));
    const execute = vi.fn(async () => {
      throw new Error('nope');
    });
    const code = await main([p], okDeps(execute));
    expect(code).toBe(EXIT_STEP_FAILED);
  });

  it('exits EXIT_OK and runs every step when everything succeeds', async () => {
    const p = writeSpec(
      'spec.yaml',
      ['steps:', '  - cmd: ping', '  - cmd: actor_spawn', '    params:', '      class: Foo'].join('\n'),
    );
    const execute = vi.fn(async () => ({ ok: true }));
    const code = await main([p], okDeps(execute));
    expect(code).toBe(EXIT_OK);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(1, 'ping', {});
    expect(execute).toHaveBeenNthCalledWith(2, 'actor_spawn', { class: 'Foo' });
  });

  it('accepts a depsFactory function form, not just a plain deps object', async () => {
    const p = writeSpec('spec.json', JSON.stringify({ steps: [{ cmd: 'ping' }] }));
    const execute = vi.fn(async () => ({ ok: true }));
    const code = await main([p], async () => okDeps(execute));
    expect(code).toBe(EXIT_OK);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
