import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { GaeaArchetypeSchema, type GaeaArchetype, type SearchInput, type FullArchetypeGraphResponse } from './types.js';
import { embed, cosineSimilarity } from './embedder.js';

type EmbeddingCache = Record<string, number[]>;

/** Dynamic weights computed from query analysis */
export interface QueryIntent {
  semanticWeight: number;
  topologyWeight: number;
  biomeWeight: number;
  phaseWeight: number;
  requiredNodes: string[];
  targetPhase?: string;
}

/** Analyze user query to determine dynamic scoring weights */
export function analyzeQueryIntent(query: string): QueryIntent {
  const q = query.toLowerCase();
  
  let semanticWeight = 0.6;
  let topologyWeight = 0.15;
  let biomeWeight = 0.15;
  let phaseWeight = 0.1;
  const requiredNodes: string[] = [];
  let targetPhase: string | undefined;

  // Detect explicit node requirements
  const nodePatterns = [
    'anastomosis', 'erosion', 'thermal', 'fold', 'crater', 'warp',
    'mountain', 'perlin', 'gradient', 'canyon', 'clip', 'blur',
    'combine', 'autolevel', 'dust', 'sandstone', 'craggy', 'snow'
  ];
  
  for (const node of nodePatterns) {
    if (q.includes(node) || q.includes(`use ${node}`) || q.includes(`${node} node`)) {
      requiredNodes.push(node);
    }
  }

  // If specific nodes mentioned, boost topology weight
  if (requiredNodes.length > 0) {
    semanticWeight = 0.3;
    topologyWeight = 0.5;
    biomeWeight = 0.1;
    phaseWeight = 0.1;
  }

  // Detect phase requirements
  if (q.includes('simulation') || q.includes('erosion') || q.includes('fluvial')) {
    targetPhase = 'simulation';
  } else if (q.includes('base') || q.includes('foundation') || q.includes('starting')) {
    targetPhase = 'base';
  } else if (q.includes('texture') || q.includes('lookdev') || q.includes('material')) {
    targetPhase = 'lookdev';
  }

  // Biome detection boosts biome weight
  const biomeWords = ['desert', 'alpine', 'coastal', 'volcanic', 'tropical', 'arctic', 'glacial', 'forest'];
  const foundBiomes = biomeWords.filter(b => q.includes(b));
  if (foundBiomes.length > 0 && requiredNodes.length === 0) {
    semanticWeight = 0.5;
    biomeWeight = 0.25;
    topologyWeight = 0.15;
    phaseWeight = 0.1;
  }

  return {
    semanticWeight,
    topologyWeight,
    biomeWeight,
    phaseWeight,
    requiredNodes,
    targetPhase,
  };
}

/** Calculate sequence similarity using normalized Jaccard index with position penalty */
function sequenceSimilarity(querySeq: string[], targetSeq: string[]): number {
  if (querySeq.length === 0) return 0;
  
  const q = querySeq.map(n => n.toLowerCase());
  const t = targetSeq.map(n => n.toLowerCase());
  
  // Exact sequence match bonus
  if (q.length === t.length && q.every((n, i) => n === t[i])) {
    return 1.0;
  }

  // Jaccard similarity for node presence
  const qSet = new Set(q);
  const tSet = new Set(t);
  const intersection = [...qSet].filter(n => tSet.has(n));
  const union = new Set([...qSet, ...tSet]);
  const jaccard = intersection.length / union.size;

  // Position-based sequence penalty
  // If order differs, reduce score
  let positionScore = 1.0;
  for (let i = 0; i < Math.min(q.length, t.length); i++) {
    if (q[i] !== t[i]) {
      positionScore -= 0.15; // Penalty for order mismatch
    }
  }
  positionScore = Math.max(0, positionScore);

  // Combined: prioritize both presence AND order
  return (jaccard * 0.6) + (positionScore * 0.4);
}

/** Search result with full scoring breakdown */
export interface ScoredArchetype {
  archetype: GaeaArchetype;
  score: number;
  breakdown: {
    semanticScore: number;
    topologyScore: number;
    biomeScore: number;
    phaseScore: number;
    sequenceScore: number;
  };
}

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

  /** Stage 1: Hybrid search with dynamic weights and sequence matching */
  async searchWithScoring(input: SearchInput): Promise<ScoredArchetype[]> {
    await this.ensureEmbeddings();

    // Analyze query intent to get dynamic weights
    const intent = analyzeQueryIntent(input.query);

    let candidates = this.archetypes;

    // Hard filter: biome_tags
    if (input.biome_tags && input.biome_tags.length > 0) {
      const filterSet = new Set(input.biome_tags.map(t => t.toLowerCase()));
      candidates = candidates.filter(a =>
        a.biome_tags.some(tag => filterSet.has(tag.toLowerCase()))
      );
    }

    // Phase filtering if detected
    if (intent.targetPhase) {
      candidates = candidates.filter(a => 
        (a.phase || 'character') === intent.targetPhase
      );
    }

    // Get embedding for query
    const queryVec = await embed(input.query);

    // Build topology sequence from filter + query nodes
    const queryTopology = input.topology_filter || intent.requiredNodes;

    const scored = candidates.map(archetype => {
      const archetypeVec = this.embeddings[archetype.pattern_name];
      
      // 1. Semantic similarity (default 60% weight)
      const semanticScore = archetypeVec ? cosineSimilarity(queryVec, archetypeVec) : 0;

      // 2. Topology presence boost (default 15% weight)
      let topologyScore = 0;
      if (queryTopology.length > 0) {
        const topoSet = new Set(queryTopology.map(t => t.toLowerCase()));
        const matches = archetype.core_topology.filter(n => topoSet.has(n.toLowerCase())).length;
        topologyScore = Math.min(matches / queryTopology.length, 1.0);
      }

      // 3. Sequence similarity bonus (NEW - order matters)
      let sequenceScore = 0;
      if (queryTopology.length > 0) {
        sequenceScore = sequenceSimilarity(queryTopology, archetype.core_topology);
      }

      // 4. Biome match boost
      let biomeScore = 0;
      if (input.biome_tags && input.biome_tags.length > 0) {
        const queryBiomes = input.biome_tags.map(b => b.toLowerCase());
        const matches = archetype.biome_tags.filter(b => queryBiomes.includes(b.toLowerCase())).length;
        biomeScore = Math.min(matches / queryBiomes.length, 1.0);
      }

      // 5. Phase match
      let phaseScore = 0;
      if (intent.targetPhase) {
        phaseScore = ((archetype.phase || 'character') === intent.targetPhase) ? 1.0 : 0;
      }

      // Apply dynamic weights from intent analysis
      const score = 
        (semanticScore * intent.semanticWeight) +
        (topologyScore * intent.topologyWeight) +
        (biomeScore * intent.biomeWeight) +
        (phaseScore * intent.phaseWeight) +
        (sequenceScore * 0.2); // Sequence bonus

      return {
        archetype,
        score,
        breakdown: {
          semanticScore,
          topologyScore,
          biomeScore,
          phaseScore,
          sequenceScore,
        },
      };
    });

    return scored.sort((a, b) => b.score - a.score);
  }

  /** Main search - returns top N results */
  async search(input: SearchInput): Promise<GaeaArchetype[]> {
    const scored = await this.searchWithScoring(input);
    return scored
      .slice(0, input.limit)
      .map(s => s.archetype);
  }

  /** Stage 1+2: Get candidates ready for LLM re-ranking */
  async searchWithCandidates(input: SearchInput, topK = 15): Promise<{
    candidates: ScoredArchetype[];
    queryIntent: QueryIntent;
  }> {
    const scored = await this.searchWithScoring({ ...input, limit: topK });
    const intent = analyzeQueryIntent(input.query);
    
    return {
      candidates: scored,
      queryIntent: intent,
    };
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

/** System prompt for Stage 2 Cross-Encoder Re-Ranking */
export const CROSS_ENCODER_SYSTEM_PROMPT = `You are a Senior Terrain Artist at a AAA game studio. Your job is to select the PERFECT Gaea workflow reference for a terrain artist to use.

Given the user's terrain request and a list of candidate workflows, you must:
1. Read the user's exact requirements carefully
2. Evaluate each candidate's semantic_intent and core_topology against the requirements
3. Consider geological realism - would this workflow actually create the described terrain?
4. Consider practical Gaea node flow - does the topology make sense?

SCORING CRITERIA:
- Perfect match: 10/10 - This exact workflow solves the user's request
- Good match: 7-9/10 - Close but may need minor tweaks
- Poor match: 1-6/10 - Wrong biome, wrong geological process, or impractical node flow
- Reject: 0/10 - Completely wrong for the request

Return your response as a JSON array of the TOP 3 candidates, ordered by rank:

[
  {"rank": 1, "pattern_name": "...", "reason": "..."},
  {"rank": 2, "pattern_name": "...", "reason": "..."},
  {"rank": 3, "pattern_name": "...", "reason": "..."}
]

If no candidates are suitable, return an empty array [].`;

export function buildReRankingPrompt(userQuery: string, candidates: ScoredArchetype[]): string {
  const candidateList = candidates.map((c, i) => `
Candidate ${i + 1}:
- Pattern: ${c.archetype.pattern_name}
- Phase: ${c.archetype.phase || 'character'}
- Semantic Intent: ${c.archetype.semantic_intent}
- Core Topology: ${c.archetype.core_topology.join(' -> ')}
- Biome Tags: ${c.archetype.biome_tags.join(', ')}
- Parameters: ${Object.entries(c.archetype.heuristic_parameters).map(([k, v]) => `${k}=${JSON.stringify(v.value)}`).join(', ')}
`).join('\n');

  return `${CROSS_ENCODER_SYSTEM_PROMPT}

USER'S TERRAIN REQUEST:
"${userQuery}"

CANDIDATE WORKFLOWS:
${candidateList}

Evaluate each candidate and return ONLY the top 3 ranked by how well they solve the user's request.`;
}
