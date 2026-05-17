import { analyzeQueryIntent, type ScoredArchetype } from './knowledge/archetype-store.js';
import type { NodeReference, BestPractice, WorkflowPattern, NodeReferenceMap } from './knowledge/knowledge-types.js';
import type { KnowledgeStore } from './knowledge/knowledge-store.js';
import type { ArchetypeStore } from './knowledge/archetype-store.js';
import { layoutGraph } from './layout-engine.js';
import { config } from '../config.js';

// ── Stage 1: Intent Analysis ────────────────────────────────────────────────

export interface TerrainIntent {
  semanticWeight: number;
  topologyWeight: number;
  biomeWeight: number;
  phaseWeight: number;
  requiredNodes: string[];
  targetPhase?: string;
  biome: string | null;
  mood: string | null;
  scale: string | null;
  geologicalProcesses: string[];
  complexityScore: number;
  estimatedNodeCount: number;
}

const BIOME_KEYWORDS: Record<string, string[]> = {
  alpine: ['alpine', 'mountain', 'highland', 'peak', 'ridge'],
  desert: ['desert', 'arid', 'dune', 'sand', 'mesa', 'canyon'],
  coastal: ['coastal', 'beach', 'shore', 'cliff', 'island', 'sea'],
  volcanic: ['volcanic', 'volcano', 'lava', 'magma', 'caldera'],
  tropical: ['tropical', 'jungle', 'rainforest', 'palm'],
  arctic: ['arctic', 'tundra', 'frozen', 'ice', 'glacier', 'glacial'],
  forest: ['forest', 'woodland', 'temperate'],
  wetland: ['swamp', 'marsh', 'bayou', 'wetland', 'bog'],
};

const MOOD_KEYWORDS: Record<string, string[]> = {
  harsh: ['harsh', 'brutal', 'extreme', 'rugged', 'desolate'],
  serene: ['serene', 'calm', 'peaceful', 'gentle', 'rolling'],
  dramatic: ['dramatic', 'epic', 'towering', 'massive', 'imposing'],
};

const SCALE_KEYWORDS: Record<string, string[]> = {
  continental: ['continental', 'huge', 'vast', 'massive', '16km', '32km'],
  regional: ['regional', 'large', 'open', '8km', '10km'],
  local: ['local', 'small', 'intimate', '2km', '4km', 'dense'],
};

const PROCESS_KEYWORDS: Record<string, string[]> = {
  erosion: ['erosion', 'eroded', 'weathered', 'worn', 'carved'],
  volcanic: ['volcanic', 'lava', 'eruption', 'magma'],
  glacial: ['glacial', 'glacier', 'ice', 'moraine'],
  fluvial: ['river', 'fluvial', 'stream', 'waterway', 'channel'],
  aeolian: ['wind', 'dune', 'aeolian', 'sand'],
  tectonic: ['tectonic', 'fold', 'uplift', 'fault'],
};

function detectKeyword(query: string, keywords: Record<string, string[]>): string | null {
  const q = query.toLowerCase();
  for (const [key, words] of Object.entries(keywords)) {
    if (words.some(w => q.includes(w))) return key;
  }
  return null;
}

function detectAllKeywords(query: string, keywords: Record<string, string[]>): string[] {
  const q = query.toLowerCase();
  const found: string[] = [];
  for (const [key, words] of Object.entries(keywords)) {
    if (words.some(w => q.includes(w))) found.push(key);
  }
  return found;
}

function estimateNodeCount(query: string, processes: string[]): number {
  let count = 3;
  count += processes.length * 2;
  if (/texture|color|material|lookdev|satmap/i.test(query)) count += 3;
  if (/snow|ice|frost/i.test(query)) count += 2;
  if (/river|water|lake|stream/i.test(query)) count += 3;
  if (/detail|realistic|complex|advanced/i.test(query)) count += 3;
  return count;
}

export function analyzeTerrainIntent(query: string): TerrainIntent {
  const baseIntent = analyzeQueryIntent(query);

  const biome = detectKeyword(query, BIOME_KEYWORDS);
  const mood = detectKeyword(query, MOOD_KEYWORDS);
  const scale = detectKeyword(query, SCALE_KEYWORDS);
  const geologicalProcesses = detectAllKeywords(query, PROCESS_KEYWORDS);
  const estimatedNodeCount = estimateNodeCount(query, geologicalProcesses);

  // If erosion/fluvial/glacial detected as geological process (not a direct phase request),
  // don't force phase filtering — the user wants the process, not a phase-locked search
  const targetPhase = (geologicalProcesses.length > 0 && baseIntent.targetPhase === 'simulation')
    ? undefined
    : baseIntent.targetPhase;

  return {
    ...baseIntent,
    targetPhase,
    biome,
    mood,
    scale,
    geologicalProcesses,
    complexityScore: 0,
    estimatedNodeCount,
  };
}

// ── Complexity Scoring ──────────────────────────────────────────────────────

const MERGE_TYPES = new Set(['Combine', 'Mixer', 'Mask']);
const TEXTURE_TYPES = new Set(['TextureBase', 'SatMap', 'SuperColor', 'HSL', 'Tint', 'Snow', 'DirtColor', 'WaterColor', 'ColorErosion', 'Splat']);

export function computeComplexityScore(
  nodes: Array<{ id: string; type: string; params: Record<string, unknown> }>,
  edges: Array<{ from: string; fromPort: string; to: string; toPort: string }>,
): number {
  const nodeCount = nodes.length;
  const mergeCount = nodes.filter(n => MERGE_TYPES.has(n.type)).length;
  const textureCount = nodes.filter(n => TEXTURE_TYPES.has(n.type)).length;

  const hasIncoming = new Set(edges.map(e => e.to));
  const branchCount = nodes.filter(n => !hasIncoming.has(n.id)).length;

  return (nodeCount * 1.0) + (branchCount * 2.0) + (mergeCount * 1.5) + (textureCount * 0.5);
}

// ── Stage 2: Knowledge Lookup ───────────────────────────────────────────────

export interface TerrainKnowledge {
  topArchetypes: ScoredArchetype[];
  relevantNodes: Map<string, NodeReference>;
  applicableRules: BestPractice[];
  suggestedPatterns: WorkflowPattern[];
}

export async function lookupKnowledge(
  intent: TerrainIntent,
  archetypeStore: ArchetypeStore,
  knowledgeStore: KnowledgeStore,
  query: string,
): Promise<TerrainKnowledge> {
  const searchResult = await archetypeStore.searchWithScoring({
    query,
    biome_tags: intent.biome ? [intent.biome] : undefined,
    topology_filter: intent.requiredNodes.length > 0 ? intent.requiredNodes : undefined,
    limit: 5,
  });

  const relevantNodes = new Map<string, NodeReference>();
  for (const scored of searchResult) {
    for (const nodeType of scored.archetype.core_topology) {
      const ref = knowledgeStore.getNode(nodeType);
      if (ref) relevantNodes.set(nodeType, ref);
    }
  }
  for (const nodeType of intent.requiredNodes) {
    const ref = knowledgeStore.getNode(nodeType);
    if (ref) relevantNodes.set(nodeType, ref);
  }

  const applicableRules = knowledgeStore.getBestPractices({
    phase: intent.targetPhase,
    nodeTypes: [...relevantNodes.keys()],
  });

  const suggestedPatterns = knowledgeStore.findPatterns({
    phase: intent.targetPhase,
    description: intent.biome ?? undefined,
  });

  return {
    topArchetypes: searchResult,
    relevantNodes,
    applicableRules,
    suggestedPatterns,
  };
}

// ── Stage 4: Layout Planning ────────────────────────────────────────────────

export interface PositionedGraphPlan {
  nodes: Array<{
    id: string;
    type: string;
    params: Record<string, unknown>;
    phase: string;
    position: { X: number; Y: number };
  }>;
  edges: Array<{
    from: string;
    fromPort: string;
    to: string;
    toPort: string;
  }>;
}

export function layoutGraphPlan(
  nodes: Array<{ id: string; type: string; params: Record<string, unknown>; phase?: string }>,
  edges: Array<{ from: string; fromPort: string; to: string; toPort: string }>,
  nodeRef?: NodeReferenceMap,
): PositionedGraphPlan {
  const positioned = layoutGraph(nodes, edges, nodeRef);
  return {
    nodes: positioned.map((n, i) => ({
      ...n,
      phase: nodes[i]?.phase ?? 'character',
    })),
    edges,
  };
}

// ── Stage 5: Critique ───────────────────────────────────────────────────────

export interface CritiqueReport {
  triggered: boolean;
  complexityScore: number;
  threshold: number;
  changes: Array<{
    type: 'added' | 'removed' | 'reordered' | 'reconnected';
    description: string;
    reason: string;
  }>;
  warnings: string[];
}

export function critiqueGraph(
  plan: PositionedGraphPlan,
  knowledge: TerrainKnowledge,
  threshold: number = config.critiqueThreshold,
  enabled: boolean = config.critiqueEnabled,
): { plan: PositionedGraphPlan; report: CritiqueReport } {
  const score = computeComplexityScore(plan.nodes, plan.edges);
  const triggered = enabled && score >= threshold;

  const report: CritiqueReport = {
    triggered,
    complexityScore: score,
    threshold,
    changes: [],
    warnings: [],
  };

  if (!triggered) {
    return { plan, report };
  }

  // Check for dead-end nodes
  const EXPORT_TYPES = new Set(['Unreal', 'Mesher', 'LightX', 'TextureBaker', 'Output']);
  const hasOutgoing = new Set(plan.edges.map(e => e.from));
  for (const node of plan.nodes) {
    if (!hasOutgoing.has(node.id) && !EXPORT_TYPES.has(node.type)) {
      report.warnings.push(`Dead-end node: "${node.id}" (${node.type}) — output goes nowhere`);
    }
  }

  // Check for consecutive identical nodes without param changes
  for (const edge of plan.edges) {
    const fromNode = plan.nodes.find(n => n.id === edge.from);
    const toNode = plan.nodes.find(n => n.id === edge.to);
    if (fromNode && toNode && fromNode.type === toNode.type) {
      const paramsMatch = JSON.stringify(fromNode.params) === JSON.stringify(toNode.params);
      if (paramsMatch) {
        report.warnings.push(`Redundant: "${fromNode.id}" and "${toNode.id}" are identical ${fromNode.type} nodes with same params`);
      }
    }
  }

  // Check port validity against knowledge
  for (const edge of plan.edges) {
    const fromNode = plan.nodes.find(n => n.id === edge.from);
    const toNode = plan.nodes.find(n => n.id === edge.to);
    if (fromNode && toNode) {
      const fromRef = knowledge.relevantNodes.get(fromNode.type);
      const toRef = knowledge.relevantNodes.get(toNode.type);
      if (fromRef && !fromRef.ports.out.includes(edge.fromPort)) {
        report.warnings.push(`Invalid port: ${fromNode.type} has no output port "${edge.fromPort}". Known: ${fromRef.ports.out.join(', ')}`);
      }
      if (toRef && !toRef.ports.in.includes(edge.toPort)) {
        report.warnings.push(`Invalid port: ${toNode.type} has no input port "${edge.toPort}". Known: ${toRef.ports.in.join(', ')}`);
      }
    }
  }

  // Check best practice violations
  for (const rule of knowledge.applicableRules) {
    if (rule.rule.toLowerCase().includes('erode before') || rule.rule.toLowerCase().includes('erosion before')) {
      const erosionIdx = plan.nodes.findIndex(n => n.type.includes('Erosion'));
      const surfaceIdx = plan.nodes.findIndex(n => n.phase === 'lookdev');
      if (surfaceIdx >= 0 && erosionIdx >= 0 && surfaceIdx < erosionIdx) {
        report.warnings.push(`Best practice violation: "${rule.rule}" — surface node appears before erosion`);
      }
    }
  }

  return { plan, report };
}
