import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { HaybaMemory } from '../gaea/memory/hayba-memory.js';
import type { AgentsManifest, ArchetypeConfig } from './types.js';

// TODO: integrate AgentRegistry into src/index.ts once tool registration moves to the meta-aware shape

export interface AgentRuntime {
  archetype: ArchetypeConfig;
  memory: HaybaMemory;
  /** True iff toolName matches any of this archetype's tool_filter glob patterns. */
  canUseTool(toolName: string): boolean;
}

const DEFAULT_MANIFEST: AgentsManifest = {
  version: 1,
  shared_memory: 'hayba-memory.db',
  archetypes: [
    {
      id: 'director',
      role: 'Director',
      system_prompt: 'Bundled fallback Director — see hayba.agents.json for the canonical list.',
      tool_filter: ['*'],
      memory_scope: 'shared',
    },
  ],
};

export function loadManifest(projectRoot: string): AgentsManifest {
  const p = path.resolve(projectRoot, 'hayba.agents.json');
  if (!existsSync(p)) {
    return DEFAULT_MANIFEST;
  }
  try {
    const raw = readFileSync(p, 'utf-8');
    return JSON.parse(raw) as AgentsManifest;
  } catch (e: unknown) {
    console.error(`[hayba] hayba.agents.json malformed (${e instanceof Error ? e.message : String(e)}); using bundled defaults`);
    return DEFAULT_MANIFEST;
  }
}

/** Convert a glob like "actor_*" or "*" into a RegExp. Only "*" wildcards supported. */
function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function createRuntime(archetype: ArchetypeConfig, memory: HaybaMemory): AgentRuntime {
  const patterns = archetype.tool_filter.map(globToRegex);
  return {
    archetype,
    memory,
    canUseTool(toolName: string) {
      return patterns.some(re => re.test(toolName));
    },
  };
}

/** One-shot loader: parse manifest, open shared memory, materialize a runtime per archetype. */
export class AgentRegistry {
  readonly manifest: AgentsManifest;
  readonly memory: HaybaMemory;
  readonly runtimes: Map<string, AgentRuntime>;

  constructor(projectRoot: string) {
    this.manifest = loadManifest(projectRoot);
    const dbPath = path.resolve(projectRoot, this.manifest.shared_memory);
    this.memory = new HaybaMemory(dbPath);
    this.runtimes = new Map();
    for (const a of this.manifest.archetypes) {
      this.runtimes.set(a.id, createRuntime(a, this.memory));
    }
  }

  get(id: string): AgentRuntime | undefined {
    return this.runtimes.get(id);
  }

  list(): AgentRuntime[] {
    return Array.from(this.runtimes.values());
  }

  close(): void {
    this.memory.close();
  }
}
