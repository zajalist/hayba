import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { analyzeConventionsHandler } from '../../src/tools/hayba-analyze-conventions.js';

const GLOBAL_PATH = join(homedir(), '.hayba', 'conventions.json');

function cleanupGlobal(): void {
  const dir = join(homedir(), '.hayba');
  if (existsSync(dir)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function createMockProject(root: string, structure: Record<string, string[]>): void {
  for (const [folder, files] of Object.entries(structure)) {
    const fullPath = join(root, 'Content', folder);
    mkdirSync(fullPath, { recursive: true });
    for (const file of files) {
      writeFileSync(join(fullPath, file), '');
    }
  }
}

describe('hayba_analyze_conventions', () => {
  let tmpDir: string;

  beforeEach(() => {
    cleanupGlobal();
    tmpDir = join('/tmp', 'test-ue-analyze-' + Date.now());
  });

  afterEach(() => {
    cleanupGlobal();
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('requires projectRoot', async () => {
    const result = await analyzeConventionsHandler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('projectRoot is required');
  });

  it('errors when Content directory does not exist', async () => {
    const result = await analyzeConventionsHandler({ projectRoot: '/tmp/nonexistent-ue-project' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Content directory not found');
  });

  it('dry run infers folder paths from mock directory tree', async () => {
    createMockProject(tmpDir, {
      PCG: ['PCG_Forest.uasset', 'PCG_Mountain.uasset'],
      Materials: ['M_Ground.uasset', 'M_Rock.uasset'],
      Blueprints: ['BP_Player.uasset', 'BP_Enemy.uasset'],
      Textures: ['T_Ground_D.uasset', 'T_Rock_N.uasset'],
    });

    const result = await analyzeConventionsHandler({ projectRoot: tmpDir });
    expect(result.isError).toBeFalsy();

    const body = JSON.parse(result.content[0].text);
    expect(body.wizard).toBe('analyze_conventions');
    expect(body.saved).toBe(false);
    expect(body.conventions.folders.pcgGraphs).toBe('/Game/PCG');
    expect(body.conventions.naming.blueprintPrefix).toBe('BP_');
    expect(body.conventions.naming.texturePrefix).toBe('T_');
  });

  it('dry run returns inferred conventions without writing any file', async () => {
    createMockProject(tmpDir, {
      PCGGraphs: ['PCG_Test.uasset'],
    });

    await analyzeConventionsHandler({ projectRoot: tmpDir });

    expect(existsSync(GLOBAL_PATH)).toBe(false);
    expect(existsSync(join(tmpDir, 'Config', 'DefaultHayba.ini'))).toBe(false);
  });

  it('save mode writes to global target', async () => {
    createMockProject(tmpDir, {
      PCG: ['PCG_Test.uasset'],
    });

    const result = await analyzeConventionsHandler({
      projectRoot: tmpDir,
      save: true,
      target: 'global',
    });
    expect(result.isError).toBeFalsy();

    const body = JSON.parse(result.content[0].text);
    expect(body.saved).toBe(true);
    expect(body.target).toBe('global');
    expect(existsSync(GLOBAL_PATH)).toBe(true);
  });

  it('save mode writes to project target', async () => {
    createMockProject(tmpDir, {
      PCG: ['PCG_Test.uasset'],
    });

    const result = await analyzeConventionsHandler({
      projectRoot: tmpDir,
      save: true,
      target: 'project',
    });
    expect(result.isError).toBeFalsy();

    const body = JSON.parse(result.content[0].text);
    expect(body.saved).toBe(true);
    expect(body.target).toBe('project');
    expect(existsSync(join(tmpDir, 'Config', 'DefaultHayba.ini'))).toBe(true);
  });

  it('save mode requires target', async () => {
    createMockProject(tmpDir, { PCG: ['PCG_Test.uasset'] });

    const result = await analyzeConventionsHandler({
      projectRoot: tmpDir,
      save: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('target is required');
  });

  it('infers naming conventions from asset prefixes', async () => {
    createMockProject(tmpDir, {
      Materials: [
        'M_Dirt.uasset', 'M_Grass.uasset', 'M_Sand.uasset',
        'M_Concrete.uasset', 'M_Wood.uasset',
      ],
      Textures: [
        'T_Dirt_D.uasset', 'T_Grass_D.uasset', 'T_Sand_N.uasset',
      ],
    });

    const result = await analyzeConventionsHandler({ projectRoot: tmpDir });
    const body = JSON.parse(result.content[0].text);

    expect(body.conventions.naming.materialPrefix).toBe('M_');
    expect(body.conventions.naming.texturePrefix).toBe('T_');
    expect(body.confidence.naming.materialPrefix.confidence).toBeGreaterThan(0.5);
  });

  it('returns confidence scores per field', async () => {
    createMockProject(tmpDir, {
      PCG: ['PCG_Test.uasset'],
    });

    const result = await analyzeConventionsHandler({ projectRoot: tmpDir });
    const body = JSON.parse(result.content[0].text);

    expect(body.confidence.folders.pcgGraphs.confidence).toBeGreaterThan(0);
    expect(body.confidence.folders.blueprints.confidence).toBe(0);
  });
});
