import { z } from 'zod';
import { defineTool } from '../register-tool.js';
import { executeCommand } from '../tool-executor.js';
import type { WorkflowStageResult } from '../workflows/contracts.js';
import { stageResult } from '../workflows/contracts.js';

export interface WorldFacts {
  worldType: string | null;
  currentLevel: string | null;
  landscapeActors: Array<Record<string, unknown>>;
  worldPartition: {
    enabled: boolean;
    runtimeGrids: string[];
    dataLayers: string[];
    hlodLayers: string[];
  };
  coordinateSystem: string | null;
  scale: number | null;
  sourceControlReady: boolean | null;
  saveReady: boolean | null;
  capabilities: {
    webBrowser: boolean;
    worldPartition: boolean;
    hlod: boolean;
  };
}

export interface WorldCapabilityReport {
  facts: WorldFacts;
  blockingErrors: WorkflowStageResult[];
  warnings: WorkflowStageResult[];
  recommendedDefaults: {
    partition: { mode: 'preserve' | 'configure' };
    validation: { mode: 'report' };
  };
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function unsupported(stage: string, code: string): WorkflowStageResult {
  return stageResult(stage, 'unsupported', { code });
}

function malformedReport(): WorldCapabilityReport {
  return {
    facts: {
      worldType: null,
      currentLevel: null,
      landscapeActors: [],
      worldPartition: { enabled: false, runtimeGrids: [], dataLayers: [], hlodLayers: [] },
      coordinateSystem: null,
      scale: null,
      sourceControlReady: null,
      saveReady: null,
      capabilities: { webBrowser: false, worldPartition: false, hlod: false },
    },
    blockingErrors: [unsupported('inspect', 'world_inspect_malformed')],
    warnings: [],
    recommendedDefaults: { partition: { mode: 'configure' }, validation: { mode: 'report' } },
  };
}

/**
 * Convert the structured world_inspect UE response into a stable capability
 * report. Only boolean fields decide support: human-readable messages are
 * intentionally ignored so an optimistic sentence can never advertise a
 * capability the engine did not explicitly report.
 */
export function normalizeWorldFacts(raw: unknown): WorldCapabilityReport {
  if (!isRecord(raw)) return malformedReport();

  const partition = isRecord(raw.worldPartition) ? raw.worldPartition : undefined;
  const enabled = typeof raw.isPartitioned === 'boolean'
    ? raw.isPartitioned
    : partition?.enabled;
  const worldPartitionSupported = typeof raw.supportsWorldPartition === 'boolean'
    ? raw.supportsWorldPartition
    : partition?.supported;
  const hlodSupported = typeof raw.supportsHlod === 'boolean' ? raw.supportsHlod : raw.hlodSupported;
  const webBrowserAvailable = typeof raw.hasWebBrowser === 'boolean' ? raw.hasWebBrowser : raw.webBrowserAvailable;

  if (
    typeof enabled !== 'boolean'
    || typeof worldPartitionSupported !== 'boolean'
    || typeof hlodSupported !== 'boolean'
    || typeof webBrowserAvailable !== 'boolean'
  ) return malformedReport();

  const facts: WorldFacts = {
    worldType: stringOrNull(raw.worldType),
    currentLevel: stringOrNull(raw.currentLevel),
    landscapeActors: records(raw.landscapeActors ?? raw.landscapes),
    worldPartition: {
      enabled,
      runtimeGrids: strings(raw.runtimeGrids ?? partition?.runtimeGrids),
      dataLayers: strings(raw.dataLayers ?? partition?.dataLayers),
      hlodLayers: strings(raw.hlodLayers ?? partition?.hlodLayers),
    },
    coordinateSystem: stringOrNull(raw.coordinateSystem),
    scale: numberOrNull(raw.scale),
    sourceControlReady: typeof raw.sourceControlReady === 'boolean' ? raw.sourceControlReady : null,
    saveReady: typeof raw.saveReady === 'boolean' ? raw.saveReady : null,
    capabilities: {
      webBrowser: webBrowserAvailable,
      worldPartition: worldPartitionSupported,
      hlod: hlodSupported,
    },
  };

  const blockingErrors: WorkflowStageResult[] = [];
  const warnings: WorkflowStageResult[] = [];
  if (!facts.capabilities.worldPartition) blockingErrors.push(unsupported('partition', 'world_partition_unavailable'));
  if (!facts.capabilities.hlod) warnings.push(unsupported('hlod', 'hlod_unavailable'));
  if (!facts.capabilities.webBrowser) warnings.push(unsupported('world_view', 'web_browser_unavailable'));

  return {
    facts,
    blockingErrors,
    warnings,
    recommendedDefaults: {
      partition: { mode: facts.worldPartition.enabled ? 'preserve' : 'configure' },
      validation: { mode: 'report' },
    },
  };
}

const worldInspectSchema = z.object({}).strict();

export const worldInspectDescriptor = defineTool({
  name: 'world_inspect',
  description: 'Inspect the open Unreal world and return normalized capability and readiness facts.',
  schema: worldInspectSchema.shape,
  meta: {
    cost: 'low',
    effects: [],
    when: 'checking the open world, World Partition, HLOD, and World-panel capability readiness before planning work',
    not_when: 'changing world settings or importing content',
  },
  cost: 'low',
  returns: 'WorldCapabilityReport with facts, blocking errors, warnings, and recommended defaults.',
  handler: async () => {
    const raw = await executeCommand<unknown>('world_inspect', {});
    const report = normalizeWorldFacts(raw);
    return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
  },
});
