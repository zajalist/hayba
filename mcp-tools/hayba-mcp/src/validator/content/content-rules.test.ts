import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateContentSnapshot, CONTENT_RULES, resolveContentThresholds } from './index.js';
import { setConfigPath, setRuleDisabled, setStrictness } from '../config.js';
import type { ContentSnapshot, MeshRow, TextureRow } from './types.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hayba-content-'));
  setConfigPath(join(tmp, 'validator-config.json'));
});
afterEach(() => {
  setConfigPath(null);
  rmSync(tmp, { recursive: true, force: true });
});

function texture(p: Partial<TextureRow> & { path: string }): TextureRow {
  return {
    format: 'PF_DXT1',
    size_x: 512,
    size_y: 512,
    memory_kb: 256,
    lod_group: 'TEXTUREGROUP_World',
    compression: 'TC_Default',
    ...p,
  };
}

function mesh(p: Partial<MeshRow> & { path: string }): MeshRow {
  return {
    tris_lod0: 1000,
    lod_count: 3,
    material_slot_count: 1,
    referencer_count: 2,
    ...p,
  };
}

function findingsFor(r: ReturnType<typeof validateContentSnapshot>, id: string) {
  return r.findings.filter((f) => f.ruleId === id);
}

describe('texture rules', () => {
  it('flags a single extreme texture as an error', () => {
    const snap: ContentSnapshot = {
      textures: [texture({ path: '/Game/T_Huge', memory_kb: 64 * 1024, size_x: 4096, size_y: 4096 })],
    };
    const found = findingsFor(validateContentSnapshot(snap, { strictness: 'standard' }), 'texture_memory_extreme');
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe('error');
    // The number must appear in readable units, not raw KB.
    expect(found[0]!.message).toContain('MB');
  });

  it('does not double-report an extreme texture as merely heavy', () => {
    const snap: ContentSnapshot = { textures: [texture({ path: '/Game/T_Huge', memory_kb: 64 * 1024 })] };
    const r = validateContentSnapshot(snap, { strictness: 'standard' });
    expect(findingsFor(r, 'texture_memory_extreme')).toHaveLength(1);
    expect(findingsFor(r, 'texture_memory_high')).toHaveLength(0);
  });

  it('trusts the audit flag for compression mismatch rather than re-guessing intent', () => {
    const snap: ContentSnapshot = {
      textures: [texture({ path: '/Game/T_Rock_Normal', format: 'PF_B8G8R8A8', outlier: true })],
    };
    const found = findingsFor(validateContentSnapshot(snap, { strictness: 'relaxed' }), 'texture_compression_mismatch');
    expect(found).toHaveLength(1);
    expect(found[0]!.hint).toMatch(/BC5/);
  });

  it('flags non-power-of-two dimensions', () => {
    const snap: ContentSnapshot = { textures: [texture({ path: '/Game/T_Odd', size_x: 500, size_y: 512 })] };
    expect(findingsFor(validateContentSnapshot(snap, { strictness: 'standard' }), 'texture_not_power_of_two')).toHaveLength(1);
  });

  it('accepts power-of-two dimensions', () => {
    const snap: ContentSnapshot = { textures: [texture({ path: '/Game/T_Ok', size_x: 1024, size_y: 256 })] };
    expect(findingsFor(validateContentSnapshot(snap, { strictness: 'standard' }), 'texture_not_power_of_two')).toHaveLength(0);
  });

  it('notices a UI texture outside the UI LOD group', () => {
    const snap: ContentSnapshot = {
      textures: [texture({ path: '/Game/UI/Icons/T_Sword', lod_group: 'TEXTUREGROUP_World' })],
    };
    expect(findingsFor(validateContentSnapshot(snap, { strictness: 'standard' }), 'texture_ui_group_mismatch')).toHaveLength(1);
  });

  it('leaves a correctly grouped UI texture alone', () => {
    const snap: ContentSnapshot = {
      textures: [texture({ path: '/Game/UI/Icons/T_Sword', lod_group: 'TEXTUREGROUP_UI' })],
    };
    expect(findingsFor(validateContentSnapshot(snap, { strictness: 'standard' }), 'texture_ui_group_mismatch')).toHaveLength(0);
  });
});

describe('mesh rules', () => {
  it('flags a heavy mesh with no LODs', () => {
    const snap: ContentSnapshot = {
      meshes: [mesh({ path: '/Game/SM_Cliff', tris_lod0: 200_000, lod_count: 1, missing_lods: true })],
    };
    const found = findingsFor(validateContentSnapshot(snap, { strictness: 'standard' }), 'mesh_missing_lods');
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('200,000');
  });

  it('does not demand LODs of a simple mesh', () => {
    const snap: ContentSnapshot = {
      meshes: [mesh({ path: '/Game/SM_Crate', tris_lod0: 500, lod_count: 1, missing_lods: true })],
    };
    expect(findingsFor(validateContentSnapshot(snap, { strictness: 'standard' }), 'mesh_missing_lods')).toHaveLength(0);
  });

  it('flags excessive material slots', () => {
    const snap: ContentSnapshot = { meshes: [mesh({ path: '/Game/SM_Kit', material_slot_count: 20 })] };
    expect(findingsFor(validateContentSnapshot(snap, { strictness: 'standard' }), 'mesh_material_slot_count')).toHaveLength(1);
  });

  it('reports an unreferenced mesh only in strict mode, and hedges about unloaded levels', () => {
    const snap: ContentSnapshot = { meshes: [mesh({ path: '/Game/SM_Orphan', referencer_count: 0 })] };
    expect(findingsFor(validateContentSnapshot(snap, { strictness: 'standard' }), 'mesh_unreferenced')).toHaveLength(0);
    const strict = findingsFor(validateContentSnapshot(snap, { strictness: 'strict' }), 'mesh_unreferenced');
    expect(strict).toHaveLength(1);
    expect(strict[0]!.hint).toMatch(/unloaded levels/);
  });
});

describe('coverage and skipping', () => {
  it('skips mesh rules when no mesh audit was supplied, rather than passing them', () => {
    const snap: ContentSnapshot = { textures: [texture({ path: '/Game/T_A' })] };
    const r = validateContentSnapshot(snap, { strictness: 'standard' });
    expect(r.rules_skipped_no_data).toContain('mesh_missing_lods');
    expect(r.rules_skipped_no_data).not.toContain('texture_not_power_of_two');
  });

  it('reports truncation so a clean result is not read as a whole-project claim', () => {
    const snap: ContentSnapshot = {
      textures: [texture({ path: '/Game/T_A' })],
      textures_scanned: 900,
    };
    const r = validateContentSnapshot(snap, { strictness: 'standard' });
    expect(r.coverage.truncated).toBe(true);
    expect(r.coverage.textures_reported).toBe(1);
    expect(r.coverage.textures_scanned).toBe(900);
  });

  it('does not claim truncation when everything scanned was reported', () => {
    const snap: ContentSnapshot = { textures: [texture({ path: '/Game/T_A' })], textures_scanned: 1, meshes: [], meshes_scanned: 0 };
    expect(validateContentSnapshot(snap, { strictness: 'standard' }).coverage.truncated).toBe(false);
  });
});

describe('strictness and configuration', () => {
  it('tightens budgets as strictness rises', () => {
    expect(resolveContentThresholds('strict').textureMemoryWarnKb)
      .toBeLessThan(resolveContentThresholds('standard').textureMemoryWarnKb);
    expect(resolveContentThresholds('standard').meshTriWarn)
      .toBeLessThan(resolveContentThresholds('relaxed').meshTriWarn);
  });

  it('raising strictness only ever adds findings', () => {
    const snap: ContentSnapshot = {
      textures: [texture({ path: '/Game/T_Mid', memory_kb: 6 * 1024, size_x: 500, size_y: 512 })],
      meshes: [mesh({ path: '/Game/SM_Mid', tris_lod0: 60_000, referencer_count: 0 })],
    };
    const relaxed = validateContentSnapshot(snap, { strictness: 'relaxed' }).findings.map((f) => f.ruleId);
    const standard = validateContentSnapshot(snap, { strictness: 'standard' }).findings.map((f) => f.ruleId);
    const strict = validateContentSnapshot(snap, { strictness: 'strict' }).findings.map((f) => f.ruleId);
    for (const id of relaxed) expect(standard).toContain(id);
    for (const id of standard) expect(strict).toContain(id);
  });

  it('honours the persisted asset-category strictness', () => {
    setStrictness('strict', 'asset');
    const snap: ContentSnapshot = { meshes: [mesh({ path: '/Game/SM_Orphan', referencer_count: 0 })] };
    const r = validateContentSnapshot(snap);
    expect(r.strictness).toBe('strict');
    expect(findingsFor(r, 'mesh_unreferenced')).toHaveLength(1);
  });

  it('reports a disabled rule as disabled rather than passing', () => {
    setRuleDisabled('texture_not_power_of_two', true);
    const snap: ContentSnapshot = { textures: [texture({ path: '/Game/T_Odd', size_x: 500, size_y: 500 })] };
    const r = validateContentSnapshot(snap, { strictness: 'standard' });
    expect(findingsFor(r, 'texture_not_power_of_two')).toHaveLength(0);
    expect(r.rules_disabled).toContain('texture_not_power_of_two');
  });
});

describe('catalogue integrity', () => {
  it('has unique ids and a declared data need', () => {
    const ids = CONTENT_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of CONTENT_RULES) expect(['textures', 'meshes']).toContain(r.needs);
  });

  it('no rule throws on an empty snapshot', () => {
    const r = validateContentSnapshot({ textures: [], meshes: [] }, { strictness: 'strict' });
    expect(r.findings.filter((f) => f.hint.includes('threw'))).toHaveLength(0);
  });

  it('every hint explains the consequence, not just the measurement', () => {
    // A finding that says only "this is big" is not actionable.
    for (const r of CONTENT_RULES) {
      const snap: ContentSnapshot = {
        textures: [texture({ path: '/Game/UI/T_X', memory_kb: 999 * 1024, size_x: 500, size_y: 500, outlier: true, lod_group: 'World' })],
        meshes: [mesh({ path: '/Game/SM_X', tris_lod0: 999_999, lod_count: 1, missing_lods: true, material_slot_count: 99, referencer_count: 0 })],
      };
      for (const f of validateContentSnapshot(snap, { strictness: 'strict', ruleIds: [r.id] }).findings) {
        expect(f.hint.length, `${r.id} hint is too thin to act on`).toBeGreaterThan(60);
      }
    }
  });
});
