import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  conventionsToIni,
  iniToConventions,
  getPreset,
} from '../src/conventions.js';

describe('conventions module', () => {
  it('conventionsToIni / iniToConventions round-trip', () => {
    const c = getPreset('epic-default');
    c.workflow.preferredLandscapeResolution = 4033;
    c.naming.folderCasing = 'snake_case';

    const ini = conventionsToIni(c);
    expect(ini).toContain('[Conventions]');
    expect(ini).toContain('preset=epic-default');
    expect(ini).toContain('folders.pcgGraphs=/Game/PCG');
    expect(ini).toContain('workflow.preferredLandscapeResolution=4033');

    const restored = iniToConventions(ini);
    expect(restored.preset).toBe('epic-default');
    expect(restored.folders.pcgGraphs).toBe('/Game/PCG');
    expect(restored.workflow.preferredLandscapeResolution).toBe(4033);
    expect(restored.naming.folderCasing).toBe('snake_case');
  });

  it('getPreset returns valid schema for each preset name', () => {
    for (const name of ['epic-default', 'gamedevtv', 'custom'] as const) {
      const c = getPreset(name);
      expect(c.version).toBe(1);
      expect(c.preset).toBe(name);
      expect(c.folders).toHaveProperty('pcgGraphs');
      expect(c.folders).toHaveProperty('landscapeMaterials');
      expect(c.folders).toHaveProperty('heightmaps');
      expect(c.folders).toHaveProperty('blueprints');
      expect(c.folders).toHaveProperty('textures');
      expect(c.naming).toHaveProperty('pcgGraphPrefix');
      expect(c.naming).toHaveProperty('materialPrefix');
      expect(c.naming).toHaveProperty('blueprintPrefix');
      expect(c.naming).toHaveProperty('texturePrefix');
      expect(c.naming).toHaveProperty('folderCasing');
      expect(c.workflow).toHaveProperty('confirmBeforeOverwrite');
      expect(c.workflow).toHaveProperty('preferredLandscapeResolution');
      expect(c.workflow).toHaveProperty('defaultHeightmapFormat');
      expect(c.workflow).toHaveProperty('autoOpenInGaeaAfterBake');
    }
  });

  it('getPreset returns independent copies', () => {
    const a = getPreset('epic-default');
    const b = getPreset('epic-default');
    a.folders.pcgGraphs = '/Game/Changed';
    expect(b.folders.pcgGraphs).toBe('/Game/PCG');
  });

  it('iniToConventions handles missing fields with defaults', () => {
    const ini = '[Conventions]\npreset=custom\nfolders.pcgGraphs=/Game/PCG\n';
    const restored = iniToConventions(ini);
    expect(restored.preset).toBe('custom');
    expect(restored.folders.pcgGraphs).toBe('/Game/PCG');
    expect(restored.folders.landscapeMaterials).toBe('');
    expect(restored.naming.folderCasing).toBe('PascalCase');
    expect(restored.workflow.confirmBeforeOverwrite).toBe(true);
  });

  it('conventionsToIni includes all fields', () => {
    const c = getPreset('gamedevtv');
    const ini = conventionsToIni(c);
    expect(ini).toContain('preset=gamedevtv');
    expect(ini).toContain('folders.pcgGraphs=/Game/PCG');
    expect(ini).toContain('naming.blueprintPrefix=BP_');
    expect(ini).toContain('workflow.confirmBeforeOverwrite=true');
  });
});
