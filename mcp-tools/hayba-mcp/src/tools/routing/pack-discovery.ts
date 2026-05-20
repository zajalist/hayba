import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import type { PackDef } from './pack-registry.js';

export function deriveDomainPacks(
  toolDirs: Map<string, string | null>,
  explicitPacks: Map<string, string>,
): PackDef[] {
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
  const raw = readFileSync(yamlPath, 'utf-8');
  const parsed = yaml.load(raw) as WorkflowPacksFile;
  return parsed.packs.map(p => ({
    name: p.name,
    kind: 'workflow' as const,
    description: p.description,
    tools: p.tools,
    autoLoadOn: p.autoLoadOn,
  }));
}
