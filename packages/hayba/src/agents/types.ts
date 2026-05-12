export interface ArchetypeConfig {
  id: string;
  role: string;
  system_prompt: string;
  tool_filter: string[];          // glob patterns: "*", "actor_*", "scene_*"
  memory_scope: 'shared' | 'private+shared';
}

export interface AgentsManifest {
  version: number;
  shared_memory: string;          // filename for HaybaMemory db (relative to project root)
  archetypes: ArchetypeConfig[];
}
