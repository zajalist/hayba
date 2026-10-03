/**
 * Cross-language contract: the Plan Mode gate must cover every non-retryable
 * command.
 *
 * Two hand-maintained lists describe the same underlying fact — "this command
 * changes state" — in two languages:
 *
 *   TS  NON_IDEMPOTENT      (tool-executor.ts)   → never auto-retry on transport failure
 *   C++ DestructiveCommands (HaybaMCPCommandHandler.cpp) → require exact approval
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
import { isDestructiveToolName } from '../../chat/agent-loop.js';

const CPP_PATH = join(
  process.cwd(),
  '../../unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCommandHandler.cpp',
);
const AGENT_LOOP_PATH = join(process.cwd(), 'src/chat/agent-loop.ts');

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

  it.runIf(available)('gates workflow primitives and public mutations in both native and agent dispatch', () => {
    for (const name of ['mesh_set_lod', 'level_save', 'world_ingest', 'asset_prepare', 'world_generate', 'hayba_import_landscape', 'import_landscape']) {
      expect(parseGatedCommands().has(name), name).toBe(true);
      expect(isDestructiveToolName(name), name).toBe(true);
    }
    const source = readFileSync(CPP_PATH, 'utf8');
    const transaction = source.slice(source.indexOf('bool FHaybaMCPCommandHandler::ShouldCreateEditorTransaction'), source.indexOf('static void MaybeShowPlanModePrompt'));
    expect(transaction).toContain('if (!IsDestructiveCommand(Cmd)) return false;');
    expect(transaction).not.toContain('TEXT("mesh_set_lod")');
    expect(transaction).toContain('if (Cmd == TEXT("level_save")) return false;');
  });

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
        `run without exact approval. Add them to the C++ set (or, if a command genuinely ` +
        `does not change state, take it out of NON_IDEMPOTENT — but not both).`,
    ).toEqual([]);
  });

  it.runIf(available)('keeps native asset registry discovery read-only and retry-safe', () => {
    expect(parseGatedCommands().has('asset_registry_query')).toBe(false);
    expect(NON_IDEMPOTENT.has('asset_registry_query')).toBe(false);
  });

  // The lease control plane must be answerable while a plan is pending and
  // while other agents hold leases. Gating lease_acquire behind Approve would
  // mean an agent cannot even queue for the world it wants to plan against.
  // A retried lease_acquire is idempotent (T7: the same owner, claims, label
  // and binding get the same lease_id back), so it stays out of NON_IDEMPOTENT.
  it.runIf(available)('keeps the lease control plane ungated and retry-safe', () => {
    const gated = parseGatedCommands();
    for (const cmd of ['lease_acquire', 'lease_renew', 'lease_release', 'lease_status', 'lease_adopt']) {
      expect(gated.has(cmd), cmd).toBe(false);
      expect(NON_IDEMPOTENT.has(cmd), cmd).toBe(false);
    }
  });

  it.runIf(available)('backs the retry-safety of lease_acquire with an idempotent table (T7)', () => {
    const policy = readFileSync(
      join(process.cwd(), '../../unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPLeasePolicy.h'),
      'utf-8',
    );
    expect(policy).toContain('if (FLease* Existing = FindReusable(Request))');
    expect(policy).toContain('Result.bReused = true;');
  });

  // The old prose-plan flag must not authorize a native write. Dispatch spends
  // an exact approval bound to the caller, command, parameters, target, lease,
  // and source. Native module code consumes the token even on a mismatch.
  it.runIf(available)('requires a single-use exact approval bound to the caller and operation', () => {
    const router = readFileSync(CPP_PATH, 'utf-8');
    const moduleSource = readFileSync(join(process.cwd(),
      '../../unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPModule.cpp'), 'utf-8');
    const moduleHeader = readFileSync(join(process.cwd(),
      '../../unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Public/HaybaMCPModule.h'), 'utf-8');
    const gateStart = router.indexOf('if (S.bPlanModeEnabled && IsDestructiveCommand(Cmd))');
    expect(gateStart).toBeGreaterThan(-1);
    const gateEnd = router.indexOf('S.PlanModeToolCallCount++', gateStart);
    expect(gateEnd).toBeGreaterThan(gateStart);
    const gate = router.slice(gateStart, gateEnd);

    expect(gate).toMatch(/ConsumeExactExternalApproval\s*\(\s*Caller\s*,\s*Cmd\s*,\s*OperationDigest\s*,\s*TargetFingerprint\s*,\s*LeaseBinding\s*,\s*SourceBinding/);
    expect(gate).not.toMatch(/\bbPlanApproved\b/);
    expect(moduleHeader).toMatch(/Owner\s*==\s*InOwner/);
    expect(moduleSource).toMatch(/ApprovedExternalOperation\.Matches\s*\(\s*Owner\s*,\s*Command/);
    expect(moduleSource).toMatch(/if\s*\(ApprovedExternalOperation\.IsValid\(\)\)\s*ApprovedExternalOperation\s*=\s*\{\s*\}\s*;/);
  });

  it.runIf(available)('gates idempotent material mutation and compile/save commands', () => {
    const gated = parseGatedCommands();
    const agentLoop = readFileSync(AGENT_LOOP_PATH, 'utf-8');
    const setStart = agentLoop.indexOf('const EXTRA_DESTRUCTIVE');
    const setEnd = agentLoop.indexOf(']);', setStart);
    expect(setStart).toBeGreaterThan(-1);
    expect(setEnd).toBeGreaterThan(setStart);
    const editorGate = agentLoop.slice(setStart, setEnd);
    for (const command of ['material_set_property', 'material_compile']) {
      expect(gated.has(command)).toBe(true);
      expect(editorGate).toContain(`'${command}'`);
      expect(NON_IDEMPOTENT.has(command)).toBe(false);
    }
  });
});
