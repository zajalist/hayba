import type { SessionManager } from '../gaea/session.js';
import type { ToolResult } from './hayba-bake-terrain.js';
import type { HaybaConventions, PresetName } from '../conventions.js';
import { getPreset, readConventions, writeGlobalConventions, writeProjectConventions } from '../conventions.js';

type Stage = 'start' | 'folders' | 'naming' | 'workflow' | 'confirm' | 'save';

export type SetupConventionsHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

interface WizardState {
  conventions: HaybaConventions;
}

function buildSummary(c: HaybaConventions): string {
  const lines = [
    '## Conventions Summary',
    '',
    `**Preset:** ${c.preset}`,
    '',
    '### Folders',
    `  PCG Graphs: ${c.folders.pcgGraphs || '(unset)'}`,
    `  Landscape Materials: ${c.folders.landscapeMaterials || '(unset)'}`,
    `  Heightmaps: ${c.folders.heightmaps || '(unset)'}`,
    `  Blueprints: ${c.folders.blueprints || '(unset)'}`,
    `  Textures: ${c.folders.textures || '(unset)'}`,
    '',
    '### Naming',
    `  PCG Graph Prefix: ${c.naming.pcgGraphPrefix || '(unset)'}`,
    `  Material Prefix: ${c.naming.materialPrefix || '(unset)'}`,
    `  Blueprint Prefix: ${c.naming.blueprintPrefix || '(unset)'}`,
    `  Texture Prefix: ${c.naming.texturePrefix || '(unset)'}`,
    `  Folder Casing: ${c.naming.folderCasing}`,
    '',
    '### Workflow',
    `  Confirm before overwrite: ${c.workflow.confirmBeforeOverwrite ? 'Yes' : 'No'}`,
    `  Preferred landscape resolution: ${c.workflow.preferredLandscapeResolution}`,
    `  Default heightmap format: ${c.workflow.defaultHeightmapFormat}`,
    `  Auto-open in Gaea after bake: ${c.workflow.autoOpenInGaeaAfterBake ? 'Yes' : 'No'}`,
  ];
  return lines.join('\n');
}

const FOLDER_FIELDS: Array<{ key: string; label: string; example: string }> = [
  { key: 'pcgGraphs', label: 'PCG Graphs folder', example: '/Game/PCG' },
  { key: 'landscapeMaterials', label: 'Landscape Materials folder', example: '/Game/Materials/Landscape' },
  { key: 'heightmaps', label: 'Heightmaps folder', example: '/Game/Terrain/Heightmaps' },
  { key: 'blueprints', label: 'Blueprints folder', example: '/Game/Blueprints' },
  { key: 'textures', label: 'Textures folder', example: '/Game/Textures' },
];

const NAMING_FIELDS: Array<{ key: string; label: string; example: string }> = [
  { key: 'pcgGraphPrefix', label: 'PCG Graph prefix', example: 'PCG_' },
  { key: 'materialPrefix', label: 'Material prefix', example: 'M_' },
  { key: 'blueprintPrefix', label: 'Blueprint prefix', example: 'BP_' },
  { key: 'texturePrefix', label: 'Texture prefix', example: 'T_' },
];

export const setupConventionsHandler: SetupConventionsHandler = async (args): Promise<ToolResult> => {
  const stage = args.stage as Stage | undefined;
  if (!stage) {
    return { content: [{ type: 'text', text: 'Error: stage is required. Valid stages: start, folders, naming, workflow, confirm, save.' }], isError: true };
  }

  const preset = args.preset as PresetName | undefined;
  const answers = (args.answers as Record<string, unknown> | undefined) ?? {};
  const target = args.target as 'global' | 'project' | undefined;
  const projectRoot = args.projectRoot as string | undefined;

  switch (stage) {
    case 'start': {
      if (!preset) {
        return { content: [{ type: 'text', text: 'Error: preset is required at start stage. Options: epic-default, gamedevtv, custom.' }], isError: true };
      }
      const c = getPreset(preset);
      const existing = readConventions();
      const existingNote = existing
        ? `\n\nCurrent active conventions: ${existing.preset} preset.`
        : '';

      const folderField = FOLDER_FIELDS[0];
      const question = {
        stage: 'folders' as const,
        field: folderField.key,
        label: folderField.label,
        current: (c.folders as Record<string, string>)[folderField.key],
        example: folderField.example,
        remaining: FOLDER_FIELDS.slice(1).map(f => f.label),
      };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            wizard: 'setup_conventions',
            stage: 'start',
            preset: c.preset,
            presetLoaded: c,
            existingNote: existingNote || 'No existing conventions found.',
            question,
          }, null, 2)
        }]
      };
    }

    case 'folders': {
      const folderAnswers = answers.folders as Record<string, string> | undefined;
      if (!folderAnswers) {
        return { content: [{ type: 'text', text: 'Error: answers.folders is required at folders stage.' }], isError: true };
      }

      // Find next unanswered folder field
      const nextField = FOLDER_FIELDS.find(f => folderAnswers[f.key] === undefined);
      if (nextField) {
        const question = {
          stage: 'folders' as const,
          field: nextField.key,
          label: nextField.label,
          current: folderAnswers[nextField.key] ?? '',
          example: nextField.example,
          remaining: FOLDER_FIELDS.filter(f => f.key !== nextField.key && folderAnswers[f.key] === undefined).map(f => f.label),
        };
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ wizard: 'setup_conventions', stage: 'folders', question }, null, 2)
          }]
        };
      }

      // All folders answered, move to naming
      const namingField = NAMING_FIELDS[0];
      const question = {
        stage: 'naming' as const,
        field: namingField.key,
        label: namingField.label,
        current: '',
        example: namingField.example,
        remaining: NAMING_FIELDS.slice(1).map(f => f.label),
      };
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ wizard: 'setup_conventions', stage: 'naming', question }, null, 2)
        }]
      };
    }

    case 'naming': {
      const namingAnswers = answers.naming as Record<string, string> | undefined;
      if (!namingAnswers) {
        return { content: [{ type: 'text', text: 'Error: answers.naming is required at naming stage.' }], isError: true };
      }

      const nextField = NAMING_FIELDS.find(f => namingAnswers[f.key] === undefined);
      if (nextField) {
        const question = {
          stage: 'naming' as const,
          field: nextField.key,
          label: nextField.label,
          current: namingAnswers[nextField.key] ?? '',
          example: nextField.example,
          remaining: NAMING_FIELDS.filter(f => f.key !== nextField.key && namingAnswers[f.key] === undefined).map(f => f.label),
        };
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ wizard: 'setup_conventions', stage: 'naming', question }, null, 2)
          }]
        };
      }

      // All naming answered, move to workflow
      const question = {
        stage: 'workflow' as const,
        fields: [
          { key: 'confirmBeforeOverwrite', label: 'Confirm before overwriting assets?', type: 'boolean', default: true },
          { key: 'preferredLandscapeResolution', label: 'Preferred landscape resolution', type: 'select', options: [1009, 2017, 4033], default: 1009 },
          { key: 'defaultHeightmapFormat', label: 'Default heightmap format', type: 'select', options: ['r16', 'png'], default: 'r16' },
          { key: 'autoOpenInGaeaAfterBake', label: 'Auto-open in Gaea after bake?', type: 'boolean', default: false },
        ],
      };
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ wizard: 'setup_conventions', stage: 'workflow', question }, null, 2)
        }]
      };
    }

    case 'workflow': {
      const wfAnswers = answers.workflow as Record<string, unknown> | undefined;
      if (!wfAnswers) {
        return { content: [{ type: 'text', text: 'Error: answers.workflow is required at workflow stage.' }], isError: true };
      }

      // Build complete conventions object
      const presetName = (answers.preset as PresetName) || 'custom';
      const c = getPreset(presetName);
      Object.assign(c.folders, answers.folders || {});
      Object.assign(c.naming, answers.naming || {});
      Object.assign(c.workflow, wfAnswers);

      const summary = buildSummary(c);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            wizard: 'setup_conventions',
            stage: 'confirm',
            summary,
            message: 'Review the conventions summary above. Reply "confirm" to proceed, or describe changes.',
          }, null, 2)
        }]
      };
    }

    case 'confirm': {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            wizard: 'setup_conventions',
            stage: 'save',
            question: {
              stage: 'save' as const,
              label: 'Where should conventions be saved?',
              options: [
                { value: 'global', description: 'Global (~/.hayba/conventions.json) — applies to all projects' },
                { value: 'project', description: 'Project-level (Config/DefaultHayba.ini) — requires projectRoot' },
              ],
            },
          }, null, 2)
        }]
      };
    }

    case 'save': {
      if (!target) {
        return { content: [{ type: 'text', text: 'Error: target is required at save stage (global or project).' }], isError: true };
      }
      if (target === 'project' && !projectRoot) {
        return { content: [{ type: 'text', text: 'Error: projectRoot is required when target is project.' }], isError: true };
      }

      // Reconstruct conventions from accumulated answers
      const presetName = (answers.preset as PresetName) || 'custom';
      const c = getPreset(presetName);
      if (answers.folders) Object.assign(c.folders, answers.folders);
      if (answers.naming) Object.assign(c.naming, answers.naming);
      if (answers.workflow) Object.assign(c.workflow, answers.workflow);

      if (target === 'global') {
        writeGlobalConventions(c);
        return { content: [{ type: 'text', text: `Conventions saved to global config (~/.hayba/conventions.json).\nPreset: ${c.preset}` }] };
      } else {
        writeProjectConventions(c, projectRoot!);
        return { content: [{ type: 'text', text: `Conventions saved to project config (${projectRoot}/Config/DefaultHayba.ini).\nPreset: ${c.preset}` }] };
      }
    }

    default:
      return { content: [{ type: 'text', text: `Error: unknown stage "${stage}".` }], isError: true };
  }
};
