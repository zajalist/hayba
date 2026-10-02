import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCatalog, knownToolNames, searchCatalog } from './skills-catalog.mjs';

const packageRoot = resolve(import.meta.dirname, '..');
const workflows = join(packageRoot, 'addons', 'workflows');
const temporary = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(body) {
  const dir = mkdtempSync(join(tmpdir(), 'hayba-skill-catalog-'));
  temporary.push(dir);
  mkdirSync(join(dir, 'hayba-fixture'));
  writeFileSync(join(dir, 'hayba-fixture', 'SKILL.md'), `---\nname: hayba-fixture\ndescription: Use when testing a focused catalog capability in a fixture.\nmetadata:\n  category: qa\n  tags: testing, validation\n---\n\n# Fixture\n\n## When to use\n\nFixture.\n\n## Tool routing\n\n${body}\n\n## Evidence\n\nRecord the result.\n`);
  return dir;
}

describe('Hayba skill catalog', () => {
  it('keeps the checked-in metadata index synchronized with every skill', () => {
    const { catalog, errors } = buildCatalog(workflows, knownToolNames(packageRoot));
    expect(errors).toEqual([]);
    expect(catalog.skills.length).toBeGreaterThanOrEqual(51);
    expect(`${JSON.stringify(catalog, null, 2)}\n`).toBe(readFileSync(join(workflows, 'catalog.json'), 'utf8'));
  });

  it('rejects an unsupported command even when written as ordinary prose', () => {
    const dir = fixture('Call fake_missing_hayba_tool to finish.');
    const { errors } = buildCatalog(dir, new Set(['scene_export']));
    expect(errors).toContain('hayba-fixture: unknown concrete tool fake_missing_hayba_tool');
  });

  it('does not admit a documented but non-callable legacy command', () => {
    expect(knownToolNames(packageRoot).has('level_get_spatial_index')).toBe(false);
    const dir = fixture('Call level_get_spatial_index for the result.');
    const { errors } = buildCatalog(dir, knownToolNames(packageRoot));
    expect(errors).toContain('hayba-fixture: unknown concrete tool level_get_spatial_index');
  });

  it('distinguishes an explicitly marked response field from a tool name', () => {
    const dir = fixture('Inspect `field:unresolved_classes` after `scene_export`.');
    const { catalog, errors } = buildCatalog(dir, new Set(['scene_export']));
    expect(errors).toEqual([]);
    expect(catalog.skills[0].tools).toEqual(['scene_export']);
  });

  it('requires cleanup in any skill that starts PIE', () => {
    const dir = fixture('Start `editor_start_pie` for a check.');
    const { errors } = buildCatalog(dir, new Set(['editor_start_pie', 'editor_stop_pie']));
    expect(errors).toContain('hayba-fixture: starts PIE without editor_stop_pie cleanup');
  });

  it('searches concise metadata and defers body loading', () => {
    const { catalog } = buildCatalog(workflows, knownToolNames(packageRoot));
    const hits = searchCatalog(catalog, 'PCGEx generated instances');
    expect(hits[0].name).toBe('hayba-pcgex-output-audit');
    expect(hits[0]).not.toHaveProperty('tools');
    expect(hits[0]).not.toHaveProperty('body');
  });
});
