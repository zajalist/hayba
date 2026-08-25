#!/usr/bin/env node
// mcp_server/src/cli/index.ts
//
// `hayba-cli` — headless runner for CI. Reads a spec file (JSON or YAML)
// listing wire commands to send to a running UE editor over the same TCP
// seam every MCP tool uses (tool-executor.ts's `executeCommand`), runs them
// in order, and exits with a code a pipeline can branch on. See
// exit-codes.ts for the contract.
//
// This does NOT launch UE. It assumes an editor (GUI or `-batchmode -Cmd`
// headless) with the HaybaMCPToolkit plugin is already running and holding
// its MCP TCP port — same precondition every other MCP tool call has. A CI
// job is expected to launch UE itself (its own step) before invoking this.
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpec, SpecParseError } from './spec.js';
import { runSpec, type RunnerDeps } from './runner.js';
import { EXIT_SPEC_ERROR, EXIT_UNEXPECTED_ERROR } from './exit-codes.js';

function printUsage(): void {
  console.error(
    [
      'Usage: hayba-cli <spec-file.json|.yaml>',
      '       hayba-cli doctor [--project <path to .uproject>]',
      '',
      'doctor checks the four things that break an install and says what to',
      'do about each: plugin present, its dependencies enabled, the editor',
      'reachable, and the two halves on matching versions.',
      '',
      'Runs each step in the spec against a running UE editor and exits:',
      '  0  all steps succeeded',
      '  1  the spec file could not be read or was malformed',
      '  2  UE was not reachable before the first step ran',
      '  3  a step failed (later steps are not attempted)',
      '  4  the CLI itself hit an unexpected error',
      '',
      'UE_TCP_PORT / UE_TCP_HOST override the target (default 127.0.0.1:52342).',
    ].join('\n'),
  );
}

/** Build the real (non-test) RunnerDeps: live TCP sender + hayba_check_ue_status.
 *  Lazily imported so `parseSpec`/`runSpec` stay importable — and unit-testable
 *  — without pulling in node:net or the process-lister. */
async function buildLiveDeps(): Promise<RunnerDeps> {
  const [{ installLiveSender, executeCommand }, { checkUeStatus }, { config }] = await Promise.all([
    import('../tools/tool-executor.js'),
    import('../tools/check-ue-status.js'),
    import('../config.js'),
  ]);

  await installLiveSender();

  return {
    checkReachable: async () => {
      const status = await checkUeStatus();
      if (status.connected) return { reachable: true, detail: '' };
      const host = config.ueTcpHost;
      const port = config.ueTcpPort;
      const hint =
        status.diagnostic ??
        status.error ??
        'no diagnostic available — the port never answered a ping.';
      return {
        reachable: false,
        detail:
          `no UE editor answered ${host}:${port}. ${hint} ` +
          `Check what (if anything) is holding this port with hayba_check_ue_status, ` +
          `or override the target with UE_TCP_PORT / UE_TCP_HOST.`,
      };
    },
    execute: (cmd, params) => executeCommand(cmd, params),
    log: (msg) => console.error(msg),
  };
}


/**
 * `hayba-cli doctor` — diagnose an install.
 *
 * Deliberately reachable without a working install: every check degrades to
 * "could not check" rather than throwing, because the whole point is to run
 * when things are broken. A doctor that needs a healthy patient is no use.
 */
export async function runDoctor(args: string[]): Promise<number> {
  const [{ diagnose, exitCodeFor, formatReport }, { gatherFacts }, { config }] = await Promise.all([
    import('./doctor.js'),
    import('./doctor-facts.js'),
    import('../config.js'),
  ]);

  let projectPath: string | null = null;
  const i = args.indexOf('--project');
  if (i !== -1 && args[i + 1]) projectPath = args[i + 1]!;

  // The probe must not require a live sender to have been installed, and must
  // not blow up when there is nothing to talk to.
  const send = async (cmd: string, params: Record<string, unknown>): Promise<unknown> => {
    const { installLiveSender, executeCommand } = await import('../tools/tool-executor.js');
    await installLiveSender();
    return executeCommand(cmd, params);
  };

  const facts = await gatherFacts({
    projectPath,
    port: config.ueTcpPort,
    here: dirname(fileURLToPath(import.meta.url)),
    send,
  });

  const results = diagnose(facts);
  console.log(formatReport(results));
  return exitCodeFor(results);
}

/**
 * Core entrypoint logic, with the UE-facing seam injectable so tests can
 * drive every exit path (spec error, unreachable UE, step failure, success)
 * without a real socket or a real spawned process. Production callers omit
 * `depsFactory` and get {@link buildLiveDeps}.
 */
export async function main(
  argv: string[],
  depsFactory: (() => Promise<RunnerDeps>) | RunnerDeps = buildLiveDeps,
): Promise<number> {
  const specPath = argv[0];
  if (!specPath || specPath === '--help' || specPath === '-h') {
    printUsage();
    return specPath ? 0 : EXIT_SPEC_ERROR;
  }

  if (specPath === 'doctor') {
    return await runDoctor(argv.slice(1));
  }

  let raw: string;
  try {
    raw = readFileSync(specPath, 'utf-8');
  } catch (err) {
    console.error(`cannot read spec file "${specPath}": ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_SPEC_ERROR;
  }

  let spec;
  try {
    spec = parseSpec(raw, specPath);
  } catch (err) {
    if (err instanceof SpecParseError) {
      console.error(`malformed spec "${specPath}": ${err.message}`);
      return EXIT_SPEC_ERROR;
    }
    throw err;
  }

  const deps = typeof depsFactory === 'function' ? await depsFactory() : depsFactory;
  const result = await runSpec(spec, deps);
  console.error(result.message);
  return result.exitCode;
}

/* c8 ignore start -- process wiring, exercised via buildLiveDeps/main unit tests, not this glue */
// Matches the compiled entry AND the source one. Only the .js form used to
// match, so running the CLI from source did nothing at all and exited 0 --
// which reads as "it worked" rather than "it never started".
const ENTRY = /[\\/]cli[\\/]index\.(js|ts)$/;
if (process.argv[1] && ENTRY.test(process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => {
      // The live TCP client's socket keeps the event loop alive even after
      // the last command's response has arrived — Node has no reason to know
      // the CLI is "done" with it. Left alone, a fully successful run hangs
      // forever instead of exiting 0, which is worse than any failure exit
      // code: CI would just time out with no signal at all. Force the exit
      // once `main` has resolved and everything has been logged.
      process.exit(code);
    })
    .catch((err) => {
      console.error(`hayba-cli crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      process.exit(EXIT_UNEXPECTED_ERROR);
    });
}
/* c8 ignore stop */
