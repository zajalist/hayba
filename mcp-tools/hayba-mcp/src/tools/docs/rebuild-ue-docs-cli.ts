import { mkdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { UeHeaderDatabaseError, rebuildUeHeaderDatabase } from './ue-header-database.js';

export const UE_DOCS_REBUILD_HELP = `Rebuild Hayba's bounded UE C++ documentation database.

Usage:
  node scripts/rebuild-ue-docs.mjs \\
    --engine-source <UE/Engine/Source> \\
    --engine-version <version> \\
    [--output <database.sqlite>] \\
    [--max-files <n>] [--max-symbols <n>]

Safety:
  The output is built in private staging, verified, fsynced and atomically renamed.
  Existing databases remain untouched on cancellation or failure. Source/output absolute
  paths are never printed or stored in the database.
`;

export interface UeDocsRebuildCliOptions {
  engineSource: string;
  engineVersion: string;
  output: string;
  maxFiles?: number;
  maxSymbols?: number;
  help: boolean;
}

export interface UeDocsRebuildCliDependencies {
  ensureDirectory(path: string): Promise<void>;
  rebuild: typeof rebuildUeHeaderDatabase;
  stdout(text: string): void;
  stderr(text: string): void;
}

const defaultDependencies: UeDocsRebuildCliDependencies = {
  ensureDirectory: async (path) => {
    await mkdir(path, { recursive: true });
  },
  rebuild: rebuildUeHeaderDatabase,
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
};

function boundedPositiveInteger(value: string, flag: string): number {
  if (!/^\d{1,9}$/u.test(value)) throw new Error(`${flag} expects a positive integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${flag} expects a positive integer`);
  return number;
}

function safePathArgument(value: string, flag: string): string {
  if (!value || value.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${flag} expects a bounded filesystem path`);
  }
  return value;
}

export function parseUeDocsRebuildArgs(argv: readonly string[]): UeDocsRebuildCliOptions {
  const seen = new Set<string>();
  let engineSource: string | undefined;
  let engineVersion: string | undefined;
  let output = resolve(process.cwd(), 'data', 'ue-docs-5.7.sqlite');
  let maxFiles: number | undefined;
  let maxSymbols: number | undefined;
  let help = false;

  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === '--help' || flag === '-h') {
      help = true;
      continue;
    }
    if (!['--engine-source', '--engine-version', '--output', '--max-files', '--max-symbols'].includes(flag)) {
      // Do not echo an unknown argument: command lines sometimes contain credentials by mistake.
      throw new Error(`unknown option at argument ${index + 1}`);
    }
    if (seen.has(flag)) throw new Error(`${flag} may be supplied only once`);
    seen.add(flag);
    const value = argv[++index];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    if (flag === '--engine-source') engineSource = safePathArgument(value, flag);
    else if (flag === '--engine-version') {
      if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(value)) {
        throw new Error('--engine-version expects a portable version label');
      }
      engineVersion = value;
    } else if (flag === '--output') output = resolve(safePathArgument(value, flag));
    else if (flag === '--max-files') maxFiles = boundedPositiveInteger(value, flag);
    else maxSymbols = boundedPositiveInteger(value, flag);
  }

  if (!help && !engineSource) throw new Error('--engine-source is required');
  if (!help && !engineVersion) throw new Error('--engine-version is required');
  return {
    engineSource: engineSource ?? '',
    engineVersion: engineVersion ?? '',
    output,
    maxFiles,
    maxSymbols,
    help,
  };
}

export async function runUeDocsRebuildCli(
  argv: readonly string[],
  dependencies: UeDocsRebuildCliDependencies = defaultDependencies,
  signal?: AbortSignal,
): Promise<number> {
  let options: UeDocsRebuildCliOptions;
  try {
    options = parseUeDocsRebuildArgs(argv);
  } catch (error) {
    dependencies.stderr(
      JSON.stringify({
        ok: false,
        code: 'invalid_arguments',
        error: error instanceof Error ? error.message : 'invalid command arguments',
        recovery: 'Run with --help for the bounded rebuild contract.',
      }),
    );
    return 2;
  }
  if (options.help) {
    dependencies.stdout(UE_DOCS_REBUILD_HELP.trimEnd());
    return 0;
  }

  const outputRoot = dirname(options.output);
  const databaseFileName = basename(options.output);
  try {
    await dependencies.ensureDirectory(outputRoot);
    const result = await dependencies.rebuild({
      sourceRoot: options.engineSource,
      engineVersion: options.engineVersion,
      outputRoot,
      databaseFileName,
      budgets: {
        ...(options.maxFiles ? { maxFiles: options.maxFiles } : {}),
        ...(options.maxSymbols ? { maxSymbols: options.maxSymbols } : {}),
      },
      databaseBudgets: {
        ...(options.maxSymbols ? { maxSymbols: options.maxSymbols } : {}),
      },
      signal,
    });
    dependencies.stdout(JSON.stringify({ ok: true, ...result }));
    return 0;
  } catch (error) {
    if (error instanceof UeHeaderDatabaseError) {
      dependencies.stderr(
        JSON.stringify({
          ok: false,
          code: error.code,
          error: error.message,
          recovery:
            error.code === 'aborted'
              ? 'Retry the rebuild when ready; the prior public database was preserved.'
              : 'Correct the input or output policy and rerun. The prior public database was preserved.',
        }),
      );
      return error.code === 'aborted' ? 130 : 1;
    }
    dependencies.stderr(
      JSON.stringify({
        ok: false,
        code: 'rebuild_failed',
        error: 'UE docs rebuild failed before a verified database could be published',
        recovery: 'Check that Engine/Source exists and the output directory is writable, then retry.',
      }),
    );
    return 1;
  }
}
