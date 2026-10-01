/**
 * Lease enforcement, cross-language source contracts (T6 creates, T8 extends).
 *
 * The native Hayba.MCP.Lease.* tests prove the behaviour inside an editor;
 * these run in the local gate. Every check fails closed: it asserts that it
 * found what it scans before judging it.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PRIVATE = join(process.cwd(), '../../unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private');
const ROUTER = join(PRIVATE, 'HaybaMCPCommandHandler.cpp');
const MANAGER = join(PRIVATE, 'HaybaMCPLeaseManager.cpp');
const POLICY = join(PRIVATE, 'HaybaMCPEnforcementPolicy.h');
const MODULE = join(PRIVATE, 'HaybaMCPModule.cpp');
const available = [ROUTER, MANAGER, POLICY, MODULE].every((f) => existsSync(f));

/** The text of the call that starts at `index`, up to its closing `);`. */
function statementAt(src: string, index: number): string {
  return src.slice(index, src.indexOf(');', index) + 2);
}

/** The FHaybaMCPLeaseManager member function whose definition encloses `index`. */
function enclosingManagerFunction(src: string, index: number): string {
  let name = '';
  for (const def of src.matchAll(/^[^\s/#][^\n]*?\bFHaybaMCPLeaseManager::(\w+)\s*\(/gm)) {
    if ((def.index ?? 0) < index) name = def[1]!;
  }
  return name;
}

describe('lease enforcement contract (T6)', () => {
  it('required native source files exist', () => {
    expect(available).toBe(true);
  });
  it('the Processing command line names owner, via, conn and lease, never the handle', () => {
    const src = readFileSync(ROUTER, 'utf-8');
    const hits = [...src.matchAll(/UE_LOG\(LogHaybaMCPCmd, Log, TEXT\("Processing command: /g)];
    expect(hits).toHaveLength(1);
    const call = statementAt(src, hits[0]!.index!);
    expect(call).toContain('Processing command: %s (id: %s, owner: %s, via: %s, conn: %d, lease: %s%s)');
    expect(call).not.toMatch(/LeaseToken/);
  });

  it('owners are resolved and sanitized in one place', () => {
    expect(readFileSync(ROUTER, 'utf-8')).toContain(
      'FHaybaMCPLeaseManager::ResolveOwner(Parsed, Context->ConnId, &Context->bOwnerFromEnvelope)',
    );
    expect(readFileSync(MANAGER, 'utf-8')).toContain('HaybaMCPEnforcement::SanitizeOwner(Owner)');
  });

  it('presence is noted after auth and before the lease gate', () => {
    const src = readFileSync(ROUTER, 'utf-8');
    const auth = src.indexOf('FHaybaMCPSecurityManager::Get().ValidateRequest(Parsed, AuthReason)');
    const presence = src.indexOf('Leases.NoteAuthenticatedCaller(');
    const gate = src.indexOf('Leases.CheckCommand(Cmd, Params)');
    expect(auth).toBeGreaterThan(-1);
    expect(presence).toBeGreaterThan(auth);
    expect(gate).toBeGreaterThan(presence);
  });

  it('every LogHaybaMCPLease warning goes through the limiter', () => {
    const src = readFileSync(MANAGER, 'utf-8');
    const sites = [...src.matchAll(/UE_LOG\(LogHaybaMCPLease, Warning/g)].map((m) =>
      enclosingManagerFunction(src, m.index!),
    );
    expect(sites.length).toBeGreaterThanOrEqual(3);
    const allowed = new Set(['NoteLeaseWarning', 'DrainLeaseWarnings', 'NoteDeprecatedParam']);
    expect(sites.filter((fn) => !allowed.has(fn))).toEqual([]);
  });

  it('the 30 s drain ticker is owned by the manager and started by the module', () => {
    expect(readFileSync(MANAGER, 'utf-8')).toContain('FTSTicker::GetCoreTicker().AddTicker(');
    const module = readFileSync(MODULE, 'utf-8');
    expect(module).toContain('FHaybaMCPLeaseManager::Get().StartWarningDrain();');
    expect(module).toContain('FHaybaMCPLeaseManager::Get().StopWarningDrain();');
  });

  it('lease times are read on the manager clock, never on the raw platform clock', () => {
    // The table runs on FHaybaMCPLeaseManager::Now(). A reader that subtracts
    // FPlatformTime::Seconds() is off by the test clock offset.
    expect(readFileSync(MANAGER, 'utf-8')).not.toContain('FPlatformTime::Seconds()');
    const state = readFileSync(join(PRIVATE, 'HaybaMCPEditorState.cpp'), 'utf-8');
    for (const signature of ['FHaybaMCPEditorState::BuildingAssets() const', 'FHaybaMCPEditorState::BusyAssetsFor(']) {
      const start = state.indexOf(signature);
      expect(start, signature).toBeGreaterThan(-1);
      const body = state.slice(start, state.indexOf('\n}', start));
      expect(body, signature).toContain('FHaybaMCPLeaseManager::Get().Now()');
      expect(body, signature).not.toContain('FPlatformTime::Seconds()');
    }
    expect(readFileSync(join(PRIVATE, 'handlers/HaybaMCPLeaseHandler.cpp'), 'utf-8')).not.toContain('FPlatformTime::Seconds()');
    expect(readFileSync(join(PRIVATE, 'handlers/HaybaMCPBatchHandler.cpp'), 'utf-8')).not.toMatch(
      /(ExpiresAt|GrantedAt|OrphanedAt)\s*-\s*(In\.Now|FPlatformTime::Seconds\(\))/,
    );
  });
});

describe('lease enforcement contract (T8, C++)', () => {
  const SETTINGS = join(PRIVATE, 'HaybaMCPDeveloperSettings.h');
  const LEASE_HANDLER = join(PRIVATE, 'handlers/HaybaMCPLeaseHandler.cpp');

  it.runIf(available)('EnforcedForWrites is the C++ default (D1)', () => {
    expect(readFileSync(SETTINGS, 'utf-8')).toContain(
      'EHaybaMCPLeaseEnforcement LeaseEnforcement = EHaybaMCPLeaseEnforcement::EnforcedForWrites;',
    );
  });

  it.runIf(available)('every enum value has a wire name', () => {
    const settings = readFileSync(SETTINGS, 'utf-8');
    const start = settings.indexOf('enum class EHaybaMCPLeaseEnforcement');
    expect(start).toBeGreaterThan(-1);
    const body = settings.slice(start, settings.indexOf('};', start));
    const values = [...body.matchAll(/^\s+(\w+),?\s*$/gm)].map((m) => m[1]);
    expect(values).toEqual(['Off', 'Advisory', 'EnforcedForWrites', 'Enforced']);
    const manager = readFileSync(MANAGER, 'utf-8');
    for (const v of values) expect(manager).toContain(`case EHaybaMCPLeaseEnforcement::${v}:`);
    const policy = readFileSync(POLICY, 'utf-8');
    for (const wire of ['off', 'advisory', 'enforced_for_writes', 'enforced']) expect(policy).toContain(`TEXT("${wire}")`);
  });

  it.runIf(available)('the mode is reported by one function and never as a number', () => {
    const files = [ROUTER, MANAGER, LEASE_HANDLER, join(PRIVATE, 'handlers/HaybaMCPLegacyHandler.cpp')];
    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      expect(src, file).not.toMatch(/\bLexEnforcement\s*\(/);
      expect(src, file).not.toMatch(/static_cast<\s*u?int\d*\s*>\s*\([^)]*LeaseEnforcement/);
    }
    expect(readFileSync(LEASE_HANDLER, 'utf-8')).toContain('FHaybaMCPLeaseManager::CurrentModeName()');
  });

  it.runIf(available)('slot 4 refuses through MakeGateRefusal and is skipped for a PIE-authorized command (R13)', () => {
    const src = readFileSync(ROUTER, 'utf-8');
    const gate = src.indexOf('Leases.CheckCommand(Cmd, Params)');
    expect(gate).toBeGreaterThan(-1);
    const window = src.slice(Math.max(0, gate - 400), gate + 1200);
    expect(window).toContain('if (!bPieAuthorized)');
    expect(window).toContain('MakeGateRefusal(Id, Cmd, Refusal)');
    expect(window).not.toContain('Envelope.SetStringField(TEXT("code"), TEXT("lease_conflict"))');
  });
});
