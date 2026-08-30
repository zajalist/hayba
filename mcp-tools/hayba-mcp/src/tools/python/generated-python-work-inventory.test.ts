import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CALLER_FORMULA_DESCRIPTORS,
  GENERATED_PYTHON_WORK_INVENTORY,
  OPEN_CALLER_COLLECTION_DESCRIPTORS,
  OPEN_CALLER_NUMERIC_DESCRIPTORS,
  OPEN_ENGINE_COLLECTION_DESCRIPTORS,
} from './generated-python-work-inventory.js';

const TOOLS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function generatedDescriptorNames(dir = TOOLS_ROOT): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      names.push(...generatedDescriptorNames(path));
      continue;
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    const source = readFileSync(path, 'utf8');
    if (!/import\s+type\s+\{[^}]*PyToolDescriptor[^}]*\}\s+from\s+['"][^'"]*py-tool-factory\.js['"]/s.test(source)) {
      continue;
    }
    for (const match of source.matchAll(/^\s*name:\s*(['"])([^'"]+)\1/gm)) {
      names.push(match[2]!);
    }
  }
  return names.sort();
}

describe('generated-Python bounded-work inventory', () => {
  it('reconciles every generated descriptor exactly once', () => {
    const sourceNames = generatedDescriptorNames();
    const inventoryNames = GENERATED_PYTHON_WORK_INVENTORY.map((item) => item.name).sort();
    expect(inventoryNames).toHaveLength(108);
    expect(new Set(inventoryNames).size).toBe(inventoryNames.length);
    expect(inventoryNames).toEqual(sourceNames);
  });

  it('requires a review status and rationale for every descriptor', () => {
    for (const item of GENERATED_PYTHON_WORK_INVENTORY) {
      expect(item.rationale.length, item.name).toBeGreaterThan(40);
      expect(['bounded-in-scope', 'fixed-caller-work', 'follow-up-open']).toContain(item.status);
      if (item.callerCollection) expect(item.status).toBe('follow-up-open');
      if (item.callerNumeric) expect(item.status).toBe('follow-up-open');
    }
  });

  it('pins the formula guards closed here and the broader caller collections open', () => {
    const inventoryNames = new Set(GENERATED_PYTHON_WORK_INVENTORY.map((item) => item.name));
    for (const name of [
      ...CALLER_FORMULA_DESCRIPTORS,
      ...OPEN_CALLER_COLLECTION_DESCRIPTORS,
      ...OPEN_CALLER_NUMERIC_DESCRIPTORS,
      ...OPEN_ENGINE_COLLECTION_DESCRIPTORS,
    ]) {
      expect(inventoryNames.has(name), name).toBe(true);
    }
    expect([...CALLER_FORMULA_DESCRIPTORS].sort()).toEqual(['foliage_scatter_paint', 'niagara_advance_simulation']);
    expect([...OPEN_CALLER_COLLECTION_DESCRIPTORS].sort()).toEqual([
      'actor_batch_transform',
      'actor_set_folder',
      'actor_set_selection',
      'asset_open_editor',
      'asset_save',
      'content_browser_sync',
      'foliage_add_instances',
      'niagara_param_set',
      'niagara_set_user_param_default',
      'pcg_set_prop',
      'water_body_river_create',
    ]);
    expect([...OPEN_CALLER_NUMERIC_DESCRIPTORS].sort()).toEqual([
      'water_body_lake_create',
      'water_body_ocean_create',
      'water_body_river_create',
      'water_waves_set_gerstner',
      'water_zone_create',
    ]);
  });

  it('pins helper-driven and native collection findings open without claiming fixes', () => {
    const byName = new Map(GENERATED_PYTHON_WORK_INVENTORY.map((item) => [item.name, item]));
    const engineCollectionFindings = [
      'actor_set_selection',
      'actor_batch_transform',
      'actor_focus',
      'actor_set_folder',
      'asset_save',
      'asset_get_source_path',
      'object_exists',
      'foliage_type_inspect',
      'foliage_add_instances',
      'landscape_get_material',
      'landscape_set_material',
      'landscape_set_lod_settings',
      'landscape_set_nanite',
      'mesh_set_material_slot',
      'niagara_set_user_param_default',
      'water_check_plugin',
      'water_body_ocean_create',
      'water_body_lake_create',
      'water_body_river_create',
    ];
    for (const name of engineCollectionFindings) {
      expect(byName.get(name)?.engineCollection, name).toBe(true);
      expect(byName.get(name)?.status, name).toBe('follow-up-open');
    }

    const callerCollectionFindings = ['niagara_param_set', 'niagara_set_user_param_default', 'pcg_set_prop'];
    for (const name of callerCollectionFindings) {
      expect(byName.get(name)?.callerCollection, name).toBe(true);
      expect(byName.get(name)?.status, name).toBe('follow-up-open');
    }
  });

  it('pins both urgent formulas to TypeScript preflight rather than generated Python', () => {
    const foliage = readFileSync(join(TOOLS_ROOT, 'foliage', 'foliage-py-tools.ts'), 'utf8');
    const niagara = readFileSync(join(TOOLS_ROOT, 'niagara', 'niagara-py-tools.ts'), 'utf8');
    expect(foliage).toContain('const candidates = preflightScatterPaint(p);');
    expect(foliage).toContain('_candidate_count = ${candidates}');
    expect(foliage).not.toContain('area_cells = (math.pi * _radius * _radius)');
    expect(niagara).toContain('const ticks = preflightNiagaraAdvance(p);');
    expect(niagara).toContain('_ticks = ${ticks}');
    expect(niagara).not.toContain('round(_secs / _dt)');
  });
});
