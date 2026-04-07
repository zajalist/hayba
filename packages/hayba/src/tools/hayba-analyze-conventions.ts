import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolResult } from './hayba-bake-terrain.js';
import type { HaybaConventions, PresetName } from '../conventions.js';
import { getPreset, writeGlobalConventions, writeProjectConventions } from '../conventions.js';

export type AnalyzeConventionsHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

interface ConfidenceField {
  value: string;
  confidence: number;
  source: string;
}

interface AnalyzedConventions extends HaybaConventions {
  confidence: {
    folders: Record<string, ConfidenceField>;
    naming: Record<string, ConfidenceField>;
  };
}

const KNOWN_FOLDER_MAP: Record<string, string[]> = {
  pcgGraphs: ['PCG', 'PCGGraphs', 'Graphs'],
  landscapeMaterials: ['LandscapeMaterials', 'Materials/Landscape', 'Landscape/Materials'],
  heightmaps: ['Heightmaps', 'Terrain/Heightmaps', 'Terrain'],
  blueprints: ['Blueprints', 'BP', 'Scripts'],
  textures: ['Textures', 'TextureLibrary'],
};

function walkContentDir(contentRoot: string, depth: number): string[] {
  if (depth <= 0 || !existsSync(contentRoot)) return [];
  const entries: string[] = [];
  try {
    for (const entry of readdirSync(contentRoot)) {
      const fullPath = join(contentRoot, entry);
      try {
        const st = statSync(fullPath);
        if (st.isDirectory()) {
          entries.push(entry);
          entries.push(...walkContentDir(fullPath, depth - 1));
        }
      } catch {
        // skip inaccessible entries
      }
    }
  } catch {
    // skip inaccessible directories
  }
  return entries;
}

function inferFolders(contentRoot: string): Record<string, ConfidenceField> {
  const folders = walkContentDir(contentRoot, 3);
  const result: Record<string, ConfidenceField> = {};

  for (const [field, patterns] of Object.entries(KNOWN_FOLDER_MAP)) {
    let best = { value: '', confidence: 0, source: '' };

    for (const pattern of patterns) {
      const parts = pattern.split('/');
      // Build candidate paths from the folder list
      for (const f of folders) {
        const match = f === parts[parts.length - 1] || f === pattern;
        if (match) {
          // Check if parent folders also match for full path match
          const fullMatch = parts.every((p, i) => {
            // Check if any folder in the list matches the partial path
            return folders.some(ff => ff.includes(p));
          });
          const conf = fullMatch ? 1.0 : 0.5;
          if (conf > best.confidence) {
            best = { value: `/Game/${pattern}`, confidence: conf, source: `folder: ${f}` };
          }
        }
      }
    }

    if (best.confidence > 0) {
      result[field] = best;
    } else {
      result[field] = { value: '', confidence: 0, source: 'not found' };
    }
  }

  return result;
}

function extractPrefix(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '');
  const idx = base.indexOf('_');
  return idx > 0 ? base.slice(0, idx + 1) : '';
}

function inferNaming(contentRoot: string): Record<string, ConfidenceField> {
  const result: Record<string, ConfidenceField> = {
    pcgGraphPrefix: { value: '', confidence: 0, source: '' },
    materialPrefix: { value: '', confidence: 0, source: '' },
    blueprintPrefix: { value: '', confidence: 0, source: '' },
    texturePrefix: { value: '', confidence: 0, source: '' },
  };

  const prefixPatterns: Record<string, string[]> = {
    pcgGraphPrefix: ['.uasset'],
    materialPrefix: ['.uasset'],
    blueprintPrefix: ['.uasset'],
    texturePrefix: ['.uasset'],
  };

  // Sample files from known folder types
  const folderPrefixMap: Array<{ folder: string; field: string }> = [
    { folder: 'PCG', field: 'pcgGraphPrefix' },
    { folder: 'PCGGraphs', field: 'pcgGraphPrefix' },
    { folder: 'Materials', field: 'materialPrefix' },
    { folder: 'Blueprints', field: 'blueprintPrefix' },
    { folder: 'Textures', field: 'texturePrefix' },
  ];

  for (const { folder, field } of folderPrefixMap) {
    const prefixes: Record<string, number> = {};
    let total = 0;

    // Find the matching folder first, then scan only within it
    const allFolders = walkContentDir(contentRoot, 3);
    const matchedFolder = allFolders.find(f => f === folder);
    if (!matchedFolder) continue;

    const targetDir = join(contentRoot, matchedFolder);

    const scanDir = (dir: string, depth: number) => {
      if (depth < 0) return;
      try {
        for (const entry of readdirSync(dir)) {
          const fullPath = join(dir, entry);
          try {
            const st = statSync(fullPath);
            if (st.isDirectory()) {
              scanDir(fullPath, depth - 1);
            } else if (entry.endsWith('.uasset')) {
              const prefix = extractPrefix(entry);
              if (prefix) {
                prefixes[prefix] = (prefixes[prefix] || 0) + 1;
              }
              total++;
              if (total >= 20) return;
            }
          } catch {
            // skip
          }
          if (total >= 20) return;
        }
      } catch {
        // skip
      }
    };

    scanDir(targetDir, 2);

    if (total > 0) {
      // Find most common prefix
      let bestPrefix = '';
      let bestCount = 0;
      for (const [p, count] of Object.entries(prefixes)) {
        if (count > bestCount) {
          bestPrefix = p;
          bestCount = count;
        }
      }
      const confidence = bestCount / total;
      result[field] = {
        value: bestPrefix,
        confidence: confidence > 0.5 ? Math.round(confidence * 10) / 10 : 0.5,
        source: `inferred from ${total} files in ${folder}/`,
      };
    }
  }

  return result;
}

export const analyzeConventionsHandler: AnalyzeConventionsHandler = async (args): Promise<ToolResult> => {
  const projectRoot = args.projectRoot as string | undefined;
  if (!projectRoot) {
    return { content: [{ type: 'text', text: 'Error: projectRoot is required.' }], isError: true };
  }

  const contentRoot = join(projectRoot, 'Content');
  if (!existsSync(contentRoot)) {
    return { content: [{ type: 'text', text: `Error: Content directory not found at ${contentRoot}. Is this a valid UE project?` }], isError: true };
  }

  const save = args.save === true;
  const target = args.target as 'global' | 'project' | undefined;

  const inferredFolders = inferFolders(contentRoot);
  const inferredNaming = inferNaming(contentRoot);

  // Build conventions object from inferred values (falling back to epic-default)
  const base = getPreset('epic-default');
  for (const [key, field] of Object.entries(inferredFolders)) {
    if (field.confidence > 0) {
      (base.folders as Record<string, string>)[key] = field.value;
    }
  }
  for (const [key, field] of Object.entries(inferredNaming)) {
    if (field.confidence > 0) {
      (base.naming as Record<string, string>)[key] = field.value;
    }
  }

  const analyzed: AnalyzedConventions = {
    ...base,
    confidence: {
      folders: inferredFolders,
      naming: inferredNaming,
    },
  };

  if (save) {
    if (!target) {
      return { content: [{ type: 'text', text: 'Error: target is required when save is true (global or project).' }], isError: true };
    }
    if (target === 'project') {
      writeProjectConventions(base, projectRoot);
    } else {
      writeGlobalConventions(base);
    }
  }

  const lines = [
    `## Analyzed Conventions${save ? ' (saved)' : ' (dry run)'}`,
    '',
    `**Project:** ${projectRoot}`,
    '',
  ];

  for (const [key, field] of Object.entries(inferredFolders)) {
    const bar = '█'.repeat(Math.round(field.confidence * 5)) + '░'.repeat(5 - Math.round(field.confidence * 5));
    lines.push(`  folders.${key}: ${field.value || '(not found)'} [${bar}] ${field.source}`);
  }

  lines.push('');

  for (const [key, field] of Object.entries(inferredNaming)) {
    const bar = '█'.repeat(Math.round(field.confidence * 5)) + '░'.repeat(5 - Math.round(field.confidence * 5));
    lines.push(`  naming.${key}: ${field.value || '(not found)'} [${bar}] ${field.source}`);
  }

  if (!save) {
    lines.push('');
    lines.push('This was a dry run. Call again with `save: true` and `target: "global" | "project"` to persist.');
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        wizard: 'analyze_conventions',
        projectRoot,
        conventions: base,
        confidence: analyzed.confidence,
        summary: lines.join('\n'),
        saved: save,
        target: save ? target : null,
      }, null, 2)
    }]
  };
};
