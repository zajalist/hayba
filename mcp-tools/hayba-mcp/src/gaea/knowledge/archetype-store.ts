// Stub — ArchetypeStore was removed when the Gaea knowledge system was refactored.
// Retained here so terrain-pipeline.ts compiles without modification.

export interface ScoredArchetype {
  score: number;
  archetype: {
    id: string;
    core_topology: string[];
    [key: string]: unknown;
  };
}

export interface BaseIntent {
  targetPhase?: string;
  requiredNodes: string[];
  semanticWeight: number;
  topologyWeight: number;
  biomeWeight: number;
  phaseWeight: number;
}

export interface ArchetypeStore {
  searchWithScoring(opts: {
    query: string;
    biome_tags?: string[];
    topology_filter?: string[];
    limit?: number;
  }): Promise<ScoredArchetype[]>;
}

export function analyzeQueryIntent(_query: string): BaseIntent {
  return {
    requiredNodes: [],
    semanticWeight: 0,
    topologyWeight: 0,
    biomeWeight: 0,
    phaseWeight: 0,
  };
}
