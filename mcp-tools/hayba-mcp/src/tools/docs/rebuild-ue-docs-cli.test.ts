import { describe, expect, it, vi } from 'vitest';
import { UeHeaderDatabaseError, type UeHeaderDatabasePublishResult } from './ue-header-database.js';
import {
  parseUeDocsRebuildArgs,
  runUeDocsRebuildCli,
  splitOutputPath,
  type UeDocsRebuildCliDependencies,
} from './rebuild-ue-docs-cli.js';

it('splits caller paths by their own flavor instead of the runner operating system', () => {
  expect(splitOutputPath('C:\\Private\\Output\\ue.sqlite')).toEqual({
    outputRoot: 'C:\\Private\\Output',
    databaseFileName: 'ue.sqlite',
  });
  expect(splitOutputPath('/private/output/ue.sqlite')).toEqual({
    outputRoot: '/private/output',
    databaseFileName: 'ue.sqlite',
  });
});

const RESULT: UeHeaderDatabasePublishResult = {
  database_file: 'ue.sqlite',
  database_schema_version: 1,
  index_schema_version: 1,
  indexer_version: 'bounded-header-v1',
  fingerprint_sha256: 'a'.repeat(64),
  symbols_written: 42,
  replaced_existing: false,
  atomic_publish: true,
  sqlite_synchronous: 'FULL',
  file_sync: 'completed',
  directory_sync: 'unsupported',
  final_permissions_adjusted: true,
  max_transaction_rows: 5_000,
};

function dependencies(overrides: Partial<UeDocsRebuildCliDependencies> = {}) {
  const stdout = vi.fn<(text: string) => void>();
  const stderr = vi.fn<(text: string) => void>();
  const ensureDirectory = vi.fn(async () => undefined);
  const rebuild = vi.fn(async () => RESULT);
  return {
    value: { stdout, stderr, ensureDirectory, rebuild, ...overrides } satisfies UeDocsRebuildCliDependencies,
    stdout,
    stderr,
    ensureDirectory,
    rebuild,
  };
}

describe('bounded UE docs rebuild CLI', () => {
  it('requires explicit source/version and never echoes an unknown option payload', async () => {
    expect(() => parseUeDocsRebuildArgs([])).toThrow('--engine-source is required');
    expect(() => parseUeDocsRebuildArgs(['--engine-source', 'Engine/Source'])).toThrow('--engine-version is required');

    const deps = dependencies();
    const exitCode = await runUeDocsRebuildCli(['--token=SECRET_VALUE'], deps.value);
    expect(exitCode).toBe(2);
    expect(deps.stderr).toHaveBeenCalledOnce();
    expect(deps.stderr.mock.calls[0]![0]).not.toContain('SECRET_VALUE');
  });

  it('shows the atomic safety contract without requiring build inputs', async () => {
    const deps = dependencies();
    expect(await runUeDocsRebuildCli(['--help'], deps.value)).toBe(0);
    expect(deps.stdout.mock.calls[0]![0]).toContain('private staging');
    expect(deps.stdout.mock.calls[0]![0]).toContain('never printed');
    expect(deps.rebuild).not.toHaveBeenCalled();
  });

  it('passes bounded options to the shared atomic builder and prints only portable result metadata', async () => {
    const deps = dependencies();
    const exitCode = await runUeDocsRebuildCli(
      [
        '--engine-source',
        'C:\\Private\\UE_5.7\\Engine\\Source',
        '--engine-version',
        '5.7.2',
        '--output',
        'C:\\Private\\Output\\ue.sqlite',
        '--max-files',
        '123',
        '--max-symbols',
        '456',
      ],
      deps.value,
    );

    expect(exitCode).toBe(0);
    expect(deps.rebuild).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceRoot: 'C:\\Private\\UE_5.7\\Engine\\Source',
        engineVersion: '5.7.2',
        databaseFileName: 'ue.sqlite',
        budgets: { maxFiles: 123, maxSymbols: 456 },
        databaseBudgets: { maxSymbols: 456 },
      }),
    );
    const output = deps.stdout.mock.calls[0]![0];
    expect(JSON.parse(output)).toMatchObject({ ok: true, database_file: 'ue.sqlite', symbols_written: 42 });
    expect(output).not.toMatch(/Private|UE_5\.7|Output|C:\\/u);
  });

  it('returns 130 on cancellation and promises that the old public database survived', async () => {
    const deps = dependencies({
      rebuild: async () => {
        throw new UeHeaderDatabaseError('aborted', 'UE header database rebuild was cancelled');
      },
    });
    const exitCode = await runUeDocsRebuildCli(
      ['--engine-source', 'Engine/Source', '--engine-version', '5.7'],
      deps.value,
    );
    expect(exitCode).toBe(130);
    const error = JSON.parse(deps.stderr.mock.calls[0]![0]);
    expect(error).toMatchObject({ ok: false, code: 'aborted' });
    expect(error.recovery).toContain('prior public database was preserved');
  });

  it('redacts unknown filesystem failures instead of serializing their private native messages', async () => {
    const deps = dependencies({
      ensureDirectory: async () => {
        throw new Error('EACCES C:\\Private\\SECRET_DIRECTORY');
      },
    });
    const exitCode = await runUeDocsRebuildCli(
      ['--engine-source', 'Engine/Source', '--engine-version', '5.7'],
      deps.value,
    );
    expect(exitCode).toBe(1);
    expect(deps.stderr.mock.calls[0]![0]).not.toMatch(/Private|SECRET_DIRECTORY|EACCES|C:\\/u);
    expect(JSON.parse(deps.stderr.mock.calls[0]![0])).toMatchObject({ ok: false, code: 'rebuild_failed' });
  });
});
