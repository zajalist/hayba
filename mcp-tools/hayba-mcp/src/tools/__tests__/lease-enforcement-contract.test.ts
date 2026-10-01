/**
 * Lease enforcement, cross-language source contracts (T6 creates, T8 extends).
 *
 * The native Hayba.MCP.Lease.* tests prove the behaviour inside an editor;
 * these run in the local gate. Every check fails closed: it asserts that it
 * found what it scans before judging it.
 */
import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { executeCommand, setDefaultSender, type Sender } from '../tool-executor.js';
import { pythonRunHandler, schema as pythonRunSchema } from '../python/python-run.js';
import { LEASE_DESCRIPTORS } from '../lease/lease-tools.js';
import { makePyToolHandler, type PyToolDescriptor } from '../py-tool-factory.js';
import { actorPyDescriptors } from '../actor/actor-py-tools.js';
import { assetPyDescriptors } from '../asset/asset-py-tools.js';
import { editorPyDescriptors } from '../editor/editor-py-tools.js';
import { foliagePyDescriptors } from '../foliage/foliage-py-tools.js';
import { landscapePyDescriptors } from '../landscape/landscape-py-tools.js';
import { lightingPyDescriptors } from '../lighting/lighting-py-tools.js';
import { meshPyDescriptors } from '../mesh/mesh-py-tools.js';
import { niagaraPyDescriptors } from '../niagara/niagara-py-tools.js';
import { sequencerPyDescriptors } from '../sequencer/sequencer-py-tools.js';
import { waterPyDescriptors } from '../water/water-py-tools.js';

vi.mock('../heavy-op-probe.js', () => ({ probeEditorProcess: async () => null }));

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

describe('lease enforcement contract (T8, wire)', () => {
  it.runIf(available)('every code the lease gate decides maps to its own UeToolError code', async () => {
    const policy = readFileSync(POLICY, 'utf-8').replace(/\r\n/g, '\n');
    const start = policy.indexOf('inline FDecision Decide(');
    expect(start).toBeGreaterThan(-1);
    const end = policy.indexOf('\n\t}\n', start);
    expect(end).toBeGreaterThan(start);
    const body = policy.slice(start, end);
    const codes = [...new Set([...body.matchAll(/TEXT\("([a-z_]+)"\)/g)].map((m) => m[1]!))].sort();
    expect(codes).toEqual(['lease_conflict', 'owner_required']);
    for (const code of codes) {
      const send: Sender = async () => ({ id: 'x', ok: false, code, error: `${code}: refused` });
      await expect(executeCommand('blueprint_add_node', {}, { sender: send })).rejects.toMatchObject({ code });
    }
  });

  it('python_run forwards read_only and resources declarations', async () => {
    const calls: Array<{ cmd: string; params: Record<string, unknown> }> = [];
    setDefaultSender(async (cmd, params) => {
      calls.push({ cmd, params });
      return { id: 'x', ok: true, data: { ok: true, stdout: '', stderr: '' } };
    });
    await pythonRunHandler({ script: 'x = 1', read_only: true }, {} as never);
    await pythonRunHandler({ script: 'x = 1', resources: ['asset:/Game/__HaybaTest__/BP_B'] }, {} as never);
    expect(calls).toEqual([
      { cmd: 'python_run', params: { script: 'x = 1', read_only: true } },
      { cmd: 'python_run', params: { script: 'x = 1', resources: ['asset:/Game/__HaybaTest__/BP_B'] } },
    ]);
  });

  it('lease_status documents the four modes and active_owners', () => {
    const status = LEASE_DESCRIPTORS.find((d) => d.name === 'lease_status');
    expect(status?.description).toContain('off / advisory / enforced_for_writes / enforced');
    expect(status?.description).toContain('active_owners');
    expect(status?.returns).toContain('active_owners');
  });

  it('accepts explicit false and resource objects without changing their declarations', async () => {
    const calls: Array<Record<string, unknown>> = [];
    setDefaultSender(async (_cmd, params) => {
      calls.push(params);
      return { id: 'x', ok: true, data: { ok: true, stdout: '', stderr: '' } };
    });
    const resources = [{ resource: 'asset:/Game/__HaybaTest__/BP_B', mode: 'shared' }, { resource: 'global' }];
    await pythonRunHandler({ script: 'x = 1', read_only: false, resources }, {} as never);
    expect(calls).toEqual([{ script: 'x = 1', read_only: false, resources }]);
  });

  it('validates declaration types and resource bounds before forwarding', () => {
    for (const declaration of [
      { read_only: 'true' }, { read_only: null }, { resources: [''] },
      { resources: ['x'.repeat(513)] }, { resources: Array(33).fill('global') },
      { resources: [{ resource: 'global', mode: null }] },
      { resources: [{ resource: 'global', mode: 'X' }] },
      { resources: [{ resource: 'global', extra: true }] },
    ]) {
      expect(pythonRunSchema.safeParse({ script: 'x = 1', ...declaration }).success, JSON.stringify(declaration)).toBe(false);
    }
  });
});

// R-1 (decided 2026-09-28): Python-backed descriptors declare read_only when they only
// read; anything undeclared is a write. A declared read is trusted by the editor, so the
// list is pinned and every entry is checked on each run.
describe('python read declarations (R-1)', () => {
  const REVIEWED_READS = [
    'actor_find', 'actor_get_selection', 'actor_inspect', 'asset_get_source_path',
    'asset_inspect', 'editor_cvar_get', 'editor_get_camera', 'foliage_capability_probe',
    'foliage_get_instance_count', 'foliage_scan_types', 'foliage_type_inspect', 'landscape_get_material',
    'landscape_inspect', 'landscape_layer_list', 'landscape_list', 'landscape_list_splines',
    'light_get', 'light_list', 'lighting_capability_probe', 'mesh_get_bounds',
    'mesh_get_lods', 'mesh_get_materials', 'mesh_get_sockets', 'niagara_component_inspect',
    'niagara_list_components', 'niagara_param_list', 'niagara_system_inspect', 'niagara_systems',
    'niagara_validate', 'object_exists', 'object_inspect', 'outliner_tree',
    'postprocess_get', 'postprocess_list_volumes', 'reflect_class', 'reflect_search_types',
    'selection_get', 'seq_inspect', 'seq_list', 'seq_list_bindings',
    'seq_validate', 'water_body_inspect', 'water_body_list', 'water_check_plugin',
    'water_validate', 'water_waves_inspect', 'water_zone_inspect',
  ];
  // Read-like by their meta, undeclared on purpose: seq_open opens the Sequencer editor,
  // and niagara_capability_probe names a spawn function in its hasattr probes.
  const UNDECLARED_ON_PURPOSE = ['niagara_capability_probe', 'seq_open'];
  const WRITE_TOKENS =
    /set_editor_property|spawn_actor|spawn_system|\bsave_(?:asset|package|loaded|map|current|directory)|destroy_actor|delete_(?:asset|directory)|compile_blueprint|\.modify\(|mark_package_dirty|execute_console_command|set_actor_selection_state|set_actor_label|select_nothing|add_possessable|duplicate_(?:asset|actor)|create_asset|rename_asset|set_(?:niagara_)?variable_|open_editor_for_assets|open_level_sequence/;
  const byFile: Array<[string, PyToolDescriptor[]]> = [
    ['actor/actor-py-tools.ts', actorPyDescriptors],
    ['asset/asset-py-tools.ts', assetPyDescriptors],
    ['editor/editor-py-tools.ts', editorPyDescriptors],
    ['foliage/foliage-py-tools.ts', foliagePyDescriptors],
    ['landscape/landscape-py-tools.ts', landscapePyDescriptors],
    ['lighting/lighting-py-tools.ts', lightingPyDescriptors],
    ['mesh/mesh-py-tools.ts', meshPyDescriptors],
    ['niagara/niagara-py-tools.ts', niagaraPyDescriptors],
    ['sequencer/sequencer-py-tools.ts', sequencerPyDescriptors],
    ['water/water-py-tools.ts', waterPyDescriptors],
  ];
  const all: PyToolDescriptor[] = byFile.flatMap(([, descriptors]) => descriptors);

  /** Newlines embedded in a JS string still separate Python call tokens. */
  function scriptSource(d: PyToolDescriptor): string {
    return d.buildScript.toString().replace(/\\[nr]/g, '\n');
  }

  /** The helper functions of a file's shared Python blocks (const PY_… = [ … ].join) that write. */
  function writerHelpers(file: string): string[] {
    const src = readFileSync(join(process.cwd(), 'src', 'tools', file), 'utf-8').replace(/\r\n/g, '\n');
    const writers = new Set<string>();
    for (const block of src.matchAll(/const PY_[A-Z_]+\s*=\s*\[([\s\S]*?)\]\.join\(/g)) {
      let current: string | null = null;
      for (const raw of block[1]!.split('\n')) {
        const line = raw.trim().replace(/^['"`]/, '').replace(/['"`],?$/, '');
        const def = /^def (\w+)\(/.exec(line);
        if (def) {
          current = def[1]!;
          continue;
        }
        if (current && line.length > 0 && !/^\s/.test(line)) current = null;
        if (current && WRITE_TOKENS.test(line)) writers.add(current);
      }
    }
    return [...writers].sort();
  }

  it('only the reviewed read tools declare read_only (a new one needs a reviewed entry here)', () => {
    expect(all.length).toBeGreaterThan(90);
    expect(REVIEWED_READS).toHaveLength(47);
    expect(all.filter((d) => d.readOnly === true).map((d) => d.name).sort()).toEqual(REVIEWED_READS);
  });

  it('a tool that declares an effect never declares read_only, and every effect-free read is accounted for', () => {
    for (const d of all.filter((x) => x.readOnly === true)) {
      expect(d.meta?.effects ?? ['no meta'], d.name).toEqual([]);
    }
    for (const name of UNDECLARED_ON_PURPOSE) {
      const descriptor = all.find((d) => d.name === name);
      expect(descriptor, name).toBeDefined();
      expect(descriptor?.readOnly, name).toBeUndefined();
    }
    const readMetaNames = byFile.flatMap(([file]) => {
      const src = readFileSync(join(process.cwd(), 'src', 'tools', file), 'utf-8');
      return [...src.matchAll(/export const \w+: PyToolDescriptor[\s\S]*?(?=\nexport const |$)/g)]
        .filter((m) => /\bmeta: readMeta,/.test(m[0]))
        .map((m) => /\bname: '([^']+)'/.exec(m[0])?.[1]);
    });
    expect(readMetaNames).toHaveLength(49);
    expect(readMetaNames.sort()).toEqual([...REVIEWED_READS, ...UNDECLARED_ON_PURPOSE].sort());
  });

  it("a read_only tool's script calls no editor writer", () => {
    for (const d of all.filter((x) => x.readOnly === true)) {
      expect(scriptSource(d), d.name).not.toMatch(WRITE_TOKENS);
    }
  });

  it("a read_only tool's script calls no shared helper that writes", () => {
    const found: Record<string, string[]> = {};
    for (const [file, descriptors] of byFile) {
      const writers = writerHelpers(file);
      found[file] = writers;
      for (const d of descriptors.filter((x) => x.readOnly === true)) {
        const script = scriptSource(d);
        for (const helper of writers) {
          expect(new RegExp(`(?<![\\w.])${helper}\\(`).test(script), `${d.name} calls ${helper}`).toBe(false);
        }
      }
    }
    // Fail closed: if the helper blocks stop parsing, this test must not pass on an empty list.
    expect(found['lighting/lighting-py-tools.ts']).toEqual(['_pp_write', '_set']);
    expect(found['sequencer/sequencer-py-tools.ts']).toEqual(['_add_possessable']);
    expect(found['water/water-py-tools.ts']).toEqual(['_mark_dirty']);
    expect(found['niagara/niagara-py-tools.ts']).toEqual(['_apply_var']);
    expect(found['foliage/foliage-py-tools.ts']).toEqual(['_set']);
  });

  it('the factory declares read_only only for a read tool', async () => {
    const calls: Array<Record<string, unknown>> = [];
    setDefaultSender(async (_cmd, params) => {
      calls.push(params);
      return { id: 'x', ok: true, data: { ok: true, stdout: 'HAYBA_JSON:{"ok":true}\n', stderr: '' } };
    });
    await makePyToolHandler(all.find((d) => d.name === 'actor_find')!)({});
    await makePyToolHandler(all.find((d) => d.name === 'actor_set_selection')!)({ actor_ids: ['X'] });
    const read = all.find((d) => d.name === 'actor_find')!;
    await makePyToolHandler({ ...read, readOnly: undefined })({});
    await makePyToolHandler({ ...read, readOnly: false })({});
    expect(calls[0]).toMatchObject({ read_only: true });
    expect(calls[1]).not.toHaveProperty('read_only');
    expect(calls[2]).not.toHaveProperty('read_only');
    expect(calls[3]).not.toHaveProperty('read_only');
  });
});
