import { readFileSync, statSync } from 'node:fs';
import { BoundedYamlError, parseBoundedYaml } from '../../security/bounded-yaml.js';
import type { PackDef } from './pack-registry.js';

export const WORKFLOW_PACKS_MAX_YAML_BYTES = 256 * 1024;

export class WorkflowPackParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowPackParseError';
  }
}

export function deriveDomainPacks(toolDirs: Map<string, string | null>, explicitPacks: Map<string, string>): PackDef[] {
  const grouped = new Map<string, string[]>();
  for (const [tool, dir] of toolDirs) {
    const explicit = explicitPacks.get(tool);
    const packName = explicit ?? dir ?? 'core';
    const arr = grouped.get(packName) ?? [];
    arr.push(tool);
    grouped.set(packName, arr);
  }
  return Array.from(grouped.entries()).map(([name, tools]) => ({
    name,
    kind: 'domain' as const,
    description: `Domain pack — tools from ${name === 'core' ? 'root src/tools/' : `src/tools/${name}/`}.`,
    tools: tools.sort(),
  }));
}

interface WorkflowPacksFile {
  packs: Array<{
    name: string;
    kind: 'workflow';
    description: string;
    tools: string[];
    autoLoadOn?: 'ue_connected';
  }>;
}

export function loadWorkflowPacks(yamlPath: string): PackDef[] {
  let raw: string;
  try {
    if (statSync(yamlPath).size > WORKFLOW_PACKS_MAX_YAML_BYTES) {
      throw new WorkflowPackParseError(
        `workflow pack manifest exceeds the ${WORKFLOW_PACKS_MAX_YAML_BYTES}-byte input limit`,
      );
    }
    raw = readFileSync(yamlPath, 'utf-8');
  } catch (error) {
    if (error instanceof WorkflowPackParseError) throw error;
    throw new WorkflowPackParseError('could not read workflow pack manifest');
  }
  return parseWorkflowPacks(raw);
}

export function parseWorkflowPacks(raw: string): PackDef[] {
  let parsed: unknown;
  try {
    parsed = parseBoundedYaml(raw, {
      label: 'workflow pack manifest',
      maxBytes: WORKFLOW_PACKS_MAX_YAML_BYTES,
    });
  } catch (error) {
    if (error instanceof BoundedYamlError) throw new WorkflowPackParseError(error.message);
    throw error;
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.packs)) {
    throw new WorkflowPackParseError('workflow pack manifest must contain a "packs" array');
  }

  const packs = parsed.packs.map((pack, index) => validateWorkflowPack(pack, index));
  return packs.map((p) => ({
    name: p.name,
    kind: 'workflow' as const,
    description: p.description,
    tools: p.tools,
    autoLoadOn: p.autoLoadOn,
  }));
}

function validateWorkflowPack(pack: unknown, index: number): WorkflowPacksFile['packs'][number] {
  if (!isRecord(pack)) {
    throw new WorkflowPackParseError(`workflow pack[${index}] must be an object`);
  }
  if (typeof pack.name !== 'string' || pack.name.trim().length === 0) {
    throw new WorkflowPackParseError(`workflow pack[${index}].name must be a non-empty string`);
  }
  if (pack.kind !== 'workflow') {
    throw new WorkflowPackParseError(`workflow pack[${index}].kind must be "workflow"`);
  }
  if (typeof pack.description !== 'string' || pack.description.trim().length === 0) {
    throw new WorkflowPackParseError(`workflow pack[${index}].description must be a non-empty string`);
  }
  if (!Array.isArray(pack.tools) || pack.tools.some((tool) => typeof tool !== 'string' || tool.length === 0)) {
    throw new WorkflowPackParseError(`workflow pack[${index}].tools must be an array of non-empty strings`);
  }
  if (pack.autoLoadOn !== undefined && pack.autoLoadOn !== 'ue_connected') {
    throw new WorkflowPackParseError(`workflow pack[${index}].autoLoadOn must be "ue_connected" when present`);
  }
  return pack as unknown as WorkflowPacksFile['packs'][number];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
