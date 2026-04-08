import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { GaeaArchetypeSchema, type GaeaArchetype, type SearchInput, type FullArchetypeGraphResponse } from './types.js';
import { embed, cosineSimilarity } from './embedder.js';

type EmbeddingCache = Record<string, number[]>;

export class ArchetypeStore {
  private archetypes: GaeaArchetype[] = [];
  private embeddings: EmbeddingCache = {};
  private embeddingsReady = false;

  constructor(
    private indexPath: string,
    private embeddingsPath: string,
    private graphsDir: string,
  ) {
    this.loadSync();
  }

  get count(): number {
    return this.archetypes.length;
  }

  private loadSync(): void {
    if (existsSync(this.indexPath)) {
      const raw = JSON.parse(readFileSync(this.indexPath, 'utf-8')) as unknown[];
      this.archetypes = raw.map(entry => GaeaArchetypeSchema.parse(entry));
    }
    if (existsSync(this.embeddingsPath)) {
      this.embeddings = JSON.parse(readFileSync(this.embeddingsPath, 'utf-8')) as EmbeddingCache;
    }
  }

  async ensureEmbeddings(): Promise<void> {
    if (this.embeddingsReady) return;
    let dirty = false;
    for (const a of this.archetypes) {
      if (!this.embeddings[a.pattern_name]) {
        this.embeddings[a.pattern_name] = await embed(a.semantic_intent);
        dirty = true;
      }
    }
    if (dirty) {
      writeFileSync(this.embeddingsPath, JSON.stringify(this.embeddings));
    }
    this.embeddingsReady = true;
  }

  async search(input: SearchInput): Promise<GaeaArchetype[]> {
    await this.ensureEmbeddings();

    let candidates = this.archetypes;

    if (input.biome_tags && input.biome_tags.length > 0) {
      const filterSet = new Set(input.biome_tags.map(t => t.toLowerCase()));
      candidates = candidates.filter(a =>
        a.biome_tags.some(tag => filterSet.has(tag.toLowerCase()))
      );
    }

    const queryVec = await embed(input.query);

    const scored = candidates.map(archetype => {
      const archetypeVec = this.embeddings[archetype.pattern_name];
      let score = archetypeVec ? cosineSimilarity(queryVec, archetypeVec) : 0;

      if (input.topology_filter && input.topology_filter.length > 0) {
        const topoSet = new Set(input.topology_filter.map(t => t.toLowerCase()));
        const matches = archetype.core_topology.filter(n => topoSet.has(n.toLowerCase())).length;
        score += matches * 0.15;
      }

      return { archetype, score };
    });

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, input.limit)
      .map(s => s.archetype);
  }

  getFullGraph(patternName: string): FullArchetypeGraphResponse | null {
    const archetype = this.archetypes.find(a => a.pattern_name === patternName);
    if (!archetype) return null;

    const slug = patternName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const graphPath = path.join(this.graphsDir, `${slug}.json`);

    if (!existsSync(graphPath)) return null;

    const graphJson = JSON.parse(readFileSync(graphPath, 'utf-8')) as Record<string, unknown>;
    return {
      pattern_name: patternName,
      full_graph_json: graphJson,
      node_positions: null,
    };
  }
}
