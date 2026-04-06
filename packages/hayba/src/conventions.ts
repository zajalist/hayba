import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// ── Schema ────────────────────────────────────────────────────────────────────

export type PresetName = 'epic-default' | 'gamedevtv' | 'custom';

export interface HaybaConventions {
  version: 1;
  preset: PresetName;

  folders: {
    pcgGraphs: string;
    landscapeMaterials: string;
    heightmaps: string;
    blueprints: string;
    textures: string;
  };

  naming: {
    pcgGraphPrefix: string;
    materialPrefix: string;
    blueprintPrefix: string;
    texturePrefix: string;
    folderCasing: 'PascalCase' | 'snake_case' | 'lowercase';
  };

  workflow: {
    confirmBeforeOverwrite: boolean;
    preferredLandscapeResolution: 1009 | 2017 | 4033;
    defaultHeightmapFormat: 'r16' | 'png';
    autoOpenInGaeaAfterBake: boolean;
  };
}

// ── Presets ───────────────────────────────────────────────────────────────────

const PRESETS: Record<PresetName, HaybaConventions> = {
  'epic-default': {
    version: 1,
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
      folderCasing: 'PascalCase',
    },
    workflow: {
      confirmBeforeOverwrite: true,
      preferredLandscapeResolution: 1009,
      defaultHeightmapFormat: 'r16',
      autoOpenInGaeaAfterBake: false,
    },
  },
  'gamedevtv': {
    version: 1,
    preset: 'gamedevtv',
    folders: {
      pcgGraphs: '/Game/PCG',
      landscapeMaterials: '/Game/Materials/Landscape',
      heightmaps: '/Game/Data/Heightmaps',
      blueprints: '/Game/Blueprints',
      textures: '/Game/Textures',
    },
    naming: {
      pcgGraphPrefix: 'PCG_',
      materialPrefix: 'M_',
      blueprintPrefix: 'BP_',
      texturePrefix: 'T_',
      folderCasing: 'PascalCase',
    },
    workflow: {
      confirmBeforeOverwrite: true,
      preferredLandscapeResolution: 1009,
      defaultHeightmapFormat: 'r16',
      autoOpenInGaeaAfterBake: false,
    },
  },
  'custom': {
    version: 1,
    preset: 'custom',
    folders: {
      pcgGraphs: '',
      landscapeMaterials: '',
      heightmaps: '',
      blueprints: '',
      textures: '',
    },
    naming: {
      pcgGraphPrefix: '',
      materialPrefix: '',
      blueprintPrefix: '',
      texturePrefix: '',
      folderCasing: 'PascalCase',
    },
    workflow: {
      confirmBeforeOverwrite: true,
      preferredLandscapeResolution: 1009,
      defaultHeightmapFormat: 'r16',
      autoOpenInGaeaAfterBake: false,
    },
  },
};

export function getPreset(name: PresetName): HaybaConventions {
  return structuredClone(PRESETS[name]);
}

// ── Paths ─────────────────────────────────────────────────────────────────────

const HAYBA_DIR = join(homedir(), '.hayba');
const GLOBAL_CONVENTIONS_PATH = join(HAYBA_DIR, 'conventions.json');

function ensureHaybaDir(): void {
  if (!existsSync(HAYBA_DIR)) {
    mkdirSync(HAYBA_DIR, { recursive: true });
  }
}

function projectIniPath(projectRoot: string): string {
  return join(projectRoot, 'Config', 'DefaultHayba.ini');
}

// ── INI serialization ─────────────────────────────────────────────────────────

function flattenConventions(c: HaybaConventions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [section, obj] of Object.entries({
    folders: c.folders,
    naming: c.naming,
    workflow: c.workflow,
  })) {
    for (const [key, value] of Object.entries(obj)) {
      out[`${section}.${key}`] = String(value);
    }
  }
  return out;
}

export function conventionsToIni(conventions: HaybaConventions): string {
  const lines = ['[Conventions]', `preset=${conventions.preset}`];
  const flat = flattenConventions(conventions);
  for (const [key, value] of Object.entries(flat)) {
    lines.push(`${key}=${value}`);
  }
  return lines.join('\n') + '\n';
}

export function iniToConventions(ini: string): HaybaConventions {
  const flat: Record<string, string> = {};
  for (const line of ini.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('[') || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    flat[key] = value;
  }

  const preset = flat['preset'] || 'custom';
  const folders = {
    pcgGraphs: flat['folders.pcgGraphs'] ?? '',
    landscapeMaterials: flat['folders.landscapeMaterials'] ?? '',
    heightmaps: flat['folders.heightmaps'] ?? '',
    blueprints: flat['folders.blueprints'] ?? '',
    textures: flat['folders.textures'] ?? '',
  };
  const naming = {
    pcgGraphPrefix: flat['naming.pcgGraphPrefix'] ?? '',
    materialPrefix: flat['naming.materialPrefix'] ?? '',
    blueprintPrefix: flat['naming.blueprintPrefix'] ?? '',
    texturePrefix: flat['naming.texturePrefix'] ?? '',
    folderCasing: (flat['naming.folderCasing'] as HaybaConventions['naming']['folderCasing']) || 'PascalCase',
  };
  const workflow = {
    confirmBeforeOverwrite: flat['workflow.confirmBeforeOverwrite'] !== 'false',
    preferredLandscapeResolution: (parseInt(flat['workflow.preferredLandscapeResolution'], 10) || 1009) as 1009 | 2017 | 4033,
    defaultHeightmapFormat: (flat['workflow.defaultHeightmapFormat'] as 'r16' | 'png') || 'r16',
    autoOpenInGaeaAfterBake: flat['workflow.autoOpenInGaeaAfterBake'] !== 'false',
  };

  return { version: 1, preset: preset as PresetName, folders, naming, workflow };
}

// ── Read / Write ──────────────────────────────────────────────────────────────

export function readConventions(projectRoot?: string): HaybaConventions | null {
  // Project-level takes full precedence
  if (projectRoot) {
    const iniPath = projectIniPath(projectRoot);
    if (existsSync(iniPath)) {
      try {
        const ini = readFileSync(iniPath, 'utf-8');
        if (ini.includes('[Conventions]')) {
          return iniToConventions(ini);
        }
      } catch {
        // fall through to global
      }
    }
  }

  // Global fallback
  if (existsSync(GLOBAL_CONVENTIONS_PATH)) {
    try {
      const raw = readFileSync(GLOBAL_CONVENTIONS_PATH, 'utf-8');
      return JSON.parse(raw) as HaybaConventions;
    } catch {
      return null;
    }
  }

  return null;
}

export function writeGlobalConventions(conventions: HaybaConventions): void {
  ensureHaybaDir();
  writeFileSync(GLOBAL_CONVENTIONS_PATH, JSON.stringify(conventions, null, 2) + '\n', 'utf-8');
}

export function writeProjectConventions(conventions: HaybaConventions, projectRoot: string): void {
  const iniPath = projectIniPath(projectRoot);
  const dir = dirname(iniPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(iniPath, conventionsToIni(conventions), 'utf-8');
}
