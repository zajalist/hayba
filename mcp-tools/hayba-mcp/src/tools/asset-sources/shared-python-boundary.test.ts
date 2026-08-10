import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../tool-executor.js', () => ({
  executeCommand: vi.fn(async () => ({ ok: true })),
}));

import { executeCommand } from '../tool-executor.js';
import { importIntoUe } from './shared.js';

describe('asset connector Python literal boundary', () => {
  beforeEach(() => vi.mocked(executeCommand).mockClear());

  it('keeps quote and newline payloads inside encoded Python string literals', async () => {
    const localDir = 'C:\\cache\\probe"\nraise SystemExit(7) #';
    const targetDir = '/Game/Probe"\nraise SystemExit(9) #';

    await expect(importIntoUe(localDir, targetDir)).resolves.toMatchObject({ ok: true });
    expect(executeCommand).toHaveBeenCalledOnce();

    const [command, params] = vi.mocked(executeCommand).mock.calls[0]!;
    expect(command).toBe('python_run');
    const script = String((params as Record<string, unknown>).script);
    const lines = script.split('\n');
    const normalized = localDir.replace(/\\/g, '/');

    expect(lines).toContain(`src_dir = ${JSON.stringify(normalized)}`);
    expect(lines).toContain(`dest_path = ${JSON.stringify(targetDir)}`);
    expect(lines.filter((line) => line.startsWith('raise SystemExit'))).toEqual([]);
    expect(script).not.toContain('exec(');
  });
});
