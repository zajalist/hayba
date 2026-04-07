import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { setupConventionsHandler } from '../../src/tools/hayba-setup-conventions.js';
import { readConventions, writeGlobalConventions, writeProjectConventions, getPreset } from '../../src/conventions.js';

const GLOBAL_PATH = join(homedir(), '.hayba', 'conventions.json');

function cleanupGlobal(): void {
  const dir = join(homedir(), '.hayba');
  if (existsSync(dir)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

describe('hayba_setup_conventions', () => {
  beforeEach(() => { cleanupGlobal(); });
  afterEach(() => { cleanupGlobal(); });

  it('start stage returns preset and first folder question', async () => {
    const result = await setupConventionsHandler({ stage: 'start', preset: 'epic-default' });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.wizard).toBe('setup_conventions');
    expect(body.stage).toBe('start');
    expect(body.preset).toBe('epic-default');
    expect(body.presetLoaded.folders.pcgGraphs).toBe('/Game/PCG');
    expect(body.question.stage).toBe('folders');
    expect(body.question.field).toBe('pcgGraphs');
  });

  it('start stage requires preset', async () => {
    const result = await setupConventionsHandler({ stage: 'start' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('preset is required');
  });

  it('folders stage asks next unanswered field', async () => {
    const result = await setupConventionsHandler({
      stage: 'folders',
      answers: {
        folders: { pcgGraphs: '/Game/PCG' },
        preset: 'epic-default',
      },
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.stage).toBe('folders');
    expect(body.question.field).toBe('landscapeMaterials');
  });

  it('folders stage moves to naming when all folders answered', async () => {
    const result = await setupConventionsHandler({
      stage: 'folders',
      answers: {
        folders: {
          pcgGraphs: '/Game/PCG',
          landscapeMaterials: '/Game/Materials/Landscape',
          heightmaps: '/Game/Terrain/Heightmaps',
          blueprints: '/Game/Blueprints',
          textures: '/Game/Textures',
        },
        preset: 'epic-default',
      },
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.stage).toBe('naming');
    expect(body.question.field).toBe('pcgGraphPrefix');
  });

  it('naming stage moves to workflow when all naming answered', async () => {
    const result = await setupConventionsHandler({
      stage: 'naming',
      answers: {
        naming: {
          pcgGraphPrefix: 'PCG_',
          materialPrefix: 'M_',
          blueprintPrefix: 'BP_',
          texturePrefix: 'T_',
        },
        folders: {
          pcgGraphs: '/Game/PCG',
          landscapeMaterials: '/Game/Materials/Landscape',
          heightmaps: '/Game/Terrain/Heightmaps',
          blueprints: '/Game/Blueprints',
          textures: '/Game/Textures',
        },
        preset: 'epic-default',
      },
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.stage).toBe('workflow');
    expect(body.question.fields.length).toBe(4);
  });

  it('workflow stage returns confirm summary', async () => {
    const result = await setupConventionsHandler({
      stage: 'workflow',
      answers: {
        workflow: {
          confirmBeforeOverwrite: true,
          preferredLandscapeResolution: 2017,
          defaultHeightmapFormat: 'png',
          autoOpenInGaeaAfterBake: true,
        },
        naming: {
          pcgGraphPrefix: 'PCG_',
          materialPrefix: 'M_',
          blueprintPrefix: 'BP_',
          texturePrefix: 'T_',
        },
        folders: {
          pcgGraphs: '/Game/PCG',
          landscapeMaterials: '/Game/Materials/Landscape',
          heightmaps: '/Game/Terrain/Heightmaps',
          blueprints: '/Game/Blueprints',
          textures: '/Game/Textures',
        },
        preset: 'epic-default',
      },
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.stage).toBe('confirm');
    expect(body.summary).toContain('## Conventions Summary');
    expect(body.summary).toContain('2017');
    expect(body.summary).toContain('png');
  });

  it('confirm stage returns save target question', async () => {
    const result = await setupConventionsHandler({ stage: 'confirm' });
    const body = JSON.parse(result.content[0].text);
    expect(body.stage).toBe('save');
    expect(body.question.options.length).toBe(2);
  });

  it('save stage writes global conventions', async () => {
    const result = await setupConventionsHandler({
      stage: 'save',
      target: 'global',
      answers: {
        preset: 'epic-default',
        folders: {
          pcgGraphs: '/Game/PCG',
          landscapeMaterials: '/Game/Materials/Landscape',
          heightmaps: '/Game/Terrain/Heightmaps',
          blueprints: '/Game/Blueprints',
          textures: '/Game/Textures',
        },
        naming: {
          pcgGraphPrefix: 'PCG_',
          materialPrefix: 'M_',
          blueprintPrefix: 'BP_',
          texturePrefix: 'T_',
        },
        workflow: {
          confirmBeforeOverwrite: true,
          preferredLandscapeResolution: 1009,
          defaultHeightmapFormat: 'r16',
          autoOpenInGaeaAfterBake: false,
        },
      },
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('global config');
    expect(existsSync(GLOBAL_PATH)).toBe(true);
  });

  it('save stage requires target', async () => {
    const result = await setupConventionsHandler({ stage: 'save' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('target is required');
  });

  it('save stage requires projectRoot for project target', async () => {
    const result = await setupConventionsHandler({ stage: 'save', target: 'project' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('projectRoot is required');
  });

  it('unknown stage returns error', async () => {
    const result = await setupConventionsHandler({ stage: 'invalid' as never });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('unknown stage');
  });
});

describe('conventions read/write', () => {
  beforeEach(() => { cleanupGlobal(); });
  afterEach(() => { cleanupGlobal(); });

  it('readConventions returns null when neither file exists', () => {
    expect(readConventions()).toBeNull();
    expect(readConventions('/tmp/fake-project')).toBeNull();
  });

  it('readConventions returns global when only global exists', () => {
    const c = getPreset('epic-default');
    writeGlobalConventions(c);
    const read = readConventions();
    expect(read).not.toBeNull();
    expect(read!.preset).toBe('epic-default');
    expect(read!.folders.pcgGraphs).toBe('/Game/PCG');
  });

  it('readConventions returns project and ignores global when both exist', () => {
    const globalC = getPreset('epic-default');
    writeGlobalConventions(globalC);

    const projectRoot = join('/tmp', 'test-ue-project-' + Date.now());
    const configDir = join(projectRoot, 'Config');
    mkdirSync(configDir, { recursive: true });

    const projectC = getPreset('custom');
    projectC.naming.blueprintPrefix = 'MY_';
    writeProjectConventions(projectC, projectRoot);

    const read = readConventions(projectRoot);
    expect(read).not.toBeNull();
    expect(read!.naming.blueprintPrefix).toBe('MY_');

    rmSync(projectRoot, { recursive: true, force: true });
  });
});
