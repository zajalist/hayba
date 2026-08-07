/**
 * Cross-language contract: the Plan Mode gate must cover every non-retryable
 * command.
 *
 * Two hand-maintained lists describe the same underlying fact — "this command
 * changes state" — in two languages:
 *
 *   TS  NON_IDEMPOTENT      (tool-executor.ts)   → never auto-retry on transport failure
 *   C++ DestructiveCommands (HaybaMCPCommandHandler.cpp) → require an approved plan
 *
 * A command whose double-execution has real side-effects is by definition
 * state-changing, so the first set must be a subset of the second. Nothing in
 * either language enforced that, and the gate drifted twice before: once a
 * command name was simply wrong ("editor_execute_console" for what is really
 * "editor_run_console_command", so console exec bypassed the gate entirely),
 * and once actor_batch_spawn could spawn actors with no plan approval while
 * actor_delete beside it was gated. A 2026-07-29 audit found 26 further
 * commands added to NON_IDEMPOTENT and never mirrored across.
 *
 * Parsing the .cpp is deliberate. The alternative — asserting against a
 * duplicated copy of the list in TS — would only prove the copy matched itself.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { NON_IDEMPOTENT } from '../tool-executor.js';

const CPP_PATH = join(
  process.cwd(),
  '../../unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCommandHandler.cpp',
);

/** Pull the command names out of the `DestructiveCommands` TSet literal. */
function parseGatedCommands(): Set<string> {
  const src = readFileSync(CPP_PATH, 'utf-8');
  const start = src.indexOf('static const TSet<FString> DestructiveCommands');
  expect(start, 'DestructiveCommands set not found — was it renamed?').toBeGreaterThan(-1);
  const end = src.indexOf('};', start);
  expect(end, 'DestructiveCommands set is unterminated').toBeGreaterThan(start);
  const body = src.slice(start, end);
  return new Set([...body.matchAll(/TEXT\("([^"]+)"\)/g)].map((m) => m[1]));
}

describe('Plan Mode gate covers every non-retryable command', () => {
  // Skipped rather than failed when the plugin source isn't checked out beside
  // the server — a missing sibling repo is not a broken contract.
  const available = existsSync(CPP_PATH);

  it.runIf(available)('parses a plausible command set out of the C++ gate', () => {
    const gated = parseGatedCommands();
    expect(gated.size).toBeGreaterThan(50);
    // Spot-check the name that was once typo'd. If this fails, the gate is
    // broken in the exact way it was broken before.
    expect(gated.has('editor_run_console_command')).toBe(true);
    expect(gated.has('python_run')).toBe(true);
  });

  it.runIf(available)('gates every command TS refuses to auto-retry', () => {
    const gated = parseGatedCommands();
    const ungated = [...NON_IDEMPOTENT].filter((cmd) => !gated.has(cmd)).sort();
    expect(
      ungated,
      `These commands are declared non-idempotent in tool-executor.ts but are NOT in ` +
        `IsDestructiveCommand() in HaybaMCPCommandHandler.cpp, so Plan Mode will let them ` +
        `run without an approved plan. Add them to the C++ set (or, if a command genuinely ` +
        `does not change state, take it out of NON_IDEMPOTENT — but not both).`,
    ).toEqual([]);
  });
});
