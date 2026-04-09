/**
 * hayba_brainstorm_gaea
 *
 * RAG-powered terrain brainstorm tool. Mandatory gate before hayba_create_terrain.
 * Multi-turn: returns archetype matches, knowledge, follow-up questions, and
 * eventually a synthesized graph plan.
 *
 * Steps: start → followup → zones (optional) → finalize
 */

import type { ToolResult } from './hayba-bake-terrain.js';
import { getStore } from './search-gaea-archetypes.js';
import { createScratchSession } from '../zones.js';
import { config } from '../config.js';
import type { GaeaArchetype } from '../gaea/knowledge/types.js';
import { KnowledgeStore } from '../gaea/knowledge/knowledge-store.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = resolve(__dirname, '..', 'gaea', 'knowledge', 'gaea-docs');

let knowledgeStore: KnowledgeStore | null = null;
function getKnowledgeStore(): KnowledgeStore {
  if (!knowledgeStore) knowledgeStore = new KnowledgeStore(DOCS_DIR);
  return knowledgeStore;
}

export type BrainstormGaeaStep = 'start' | 'followup' | 'zones' | 'finalize';

export interface BrainstormGaeaResult {
  step: BrainstormGaeaStep;
  archetypes: GaeaArchetype[];
  best_practices: Array<{ id?: string; category: string; rule: string }>;
  workflow_patterns: Array<{ description: string; when_to_use: string; nodes: string[] }>;
  common_mistakes: string[];
  node_zone_strategies: Record<string, { strategy: string; position_params: string[] }>;
  follow_up_questions: string[];
  suggested_plan: {
    nodes: Array<{ id: string; type: string; params: Record<string, unknown> }>;
    edges: Array<{ from: string; fromPort: string; to: string; toPort: string }>;
    reasoning: string;
  } | null;
  final_graph: {
    nodes: Array<{ id: string; type: string; params: Record<string, unknown> }>;
    edges: Array<{ from: string; fromPort: string; to: string; toPort: string }>;
  } | null;
  scratchSessionId?: string;
  painterUrl?: string;
}

export async function brainstormGaeaHandler(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const prompt = args.prompt as string | undefined;
  const step = (args.step as BrainstormGaeaStep) ?? 'start';
  const answer = args.answer as string | undefined;

  if (!prompt) {
    return {
      content: [{ type: 'text', text: 'Error: prompt is required.' }],
      isError: true,
    };
  }

  const archetypeStore = getStore();
  const ks = getKnowledgeStore();

  const result: BrainstormGaeaResult = {
    step,
    archetypes: [],
    best_practices: [],
    workflow_patterns: [],
    common_mistakes: [],
    node_zone_strategies: {},
    follow_up_questions: [],
    suggested_plan: null,
    final_graph: null,
  };

  switch (step) {
    case 'start':
    case 'followup': {
      const searchQuery = answer ? `${prompt} ${answer}` : prompt;

      // RAG: search archetypes
      const archetypes = await archetypeStore.search({ query: searchQuery, limit: 5 });
      result.archetypes = archetypes;

      // Collect all node types from top archetypes
      const allNodeTypes = [...new Set(archetypes.flatMap(a => a.core_topology))];

      // Zone strategy lookup for each node type
      for (const nodeType of allNodeTypes) {
        const nodeRef = ks.getNode(nodeType);
        if (nodeRef) {
          result.node_zone_strategies[nodeType] = {
            strategy: nodeRef.zone_strategy ?? 'none',
            position_params: nodeRef.position_params ?? [],
          };
        }
      }

      // RAG: best practices
      result.best_practices = ks.getBestPractices({ nodeTypes: allNodeTypes });

      // RAG: workflow patterns
      result.workflow_patterns = ks.findPatterns({ description: searchQuery }).map(p => ({
        description: p.description,
        when_to_use: p.when_to_use,
        nodes: p.nodes,
      }));

      // Collect common mistakes from enriched archetypes
      result.common_mistakes = [
        ...new Set(archetypes.flatMap(a => a.common_mistakes ?? [])),
      ];

      // Build suggested plan from best matching archetype
      if (archetypes.length > 0) {
        const best = archetypes[0];
        if (best.graph) {
          result.suggested_plan = {
            nodes: best.graph.nodes.map(n => ({ id: n.id, type: n.type, params: n.params as Record<string, unknown> })),
            edges: best.graph.edges,
            reasoning: `Based on "${best.pattern_name}": ${best.semantic_intent}`,
          };
        } else {
          const nodes = best.core_topology.map((type, i) => ({
            id: `node_${i}`,
            type,
            params: {} as Record<string, unknown>,
          }));
          const edges = [];
          for (let i = 0; i < nodes.length - 1; i++) {
            edges.push({ from: nodes[i].id, fromPort: 'Out', to: nodes[i + 1].id, toPort: 'In' });
          }
          result.suggested_plan = {
            nodes,
            edges,
            reasoning: `Linear chain from "${best.pattern_name}": ${best.semantic_intent}. Note: simplified topology — review and adapt connections.`,
          };
        }
      }

      // Generate follow-up questions for under-specified prompts
      if (step === 'start') {
        if (!/\b(small|mid|large|km|meters?|continental|regional|local)\b/i.test(prompt)) {
          result.follow_up_questions.push('What scale should this terrain be? (e.g. small 2-4 km², mid 8-10 km², or large 16+ km²)');
        }
        if (!/\b(sharp|soft|smooth|rugged|eroded|weathered)\b/i.test(prompt)) {
          result.follow_up_questions.push('What erosion character? Sharp ridges, soft rolling hills, or heavily weathered?');
        }
        if (!/\b(snow|color|texture|satmap|green|brown|red)\b/i.test(prompt)) {
          result.follow_up_questions.push('Do you want the terrain with coloring/textures, or just the heightmap shape?');
        }
      }

      break;
    }

    case 'zones': {
      const session = createScratchSession();
      result.scratchSessionId = session.scratchSessionId;
      result.painterUrl = `http://${config.dashboardHost}:${config.dashboardPort}/#scratch/${session.scratchSessionId}/zones`;
      break;
    }

    case 'finalize': {
      const archetypes = await archetypeStore.search({ query: prompt, limit: 3 });
      result.archetypes = archetypes;

      if (archetypes.length > 0) {
        const best = archetypes[0];
        if (best.graph) {
          result.final_graph = {
            nodes: best.graph.nodes.map(n => ({ id: n.id, type: n.type, params: n.params as Record<string, unknown> })),
            edges: best.graph.edges,
          };
        } else {
          const nodes = best.core_topology.map((type, i) => ({
            id: `node_${i}`,
            type,
            params: {} as Record<string, unknown>,
          }));
          const edges = [];
          for (let i = 0; i < nodes.length - 1; i++) {
            edges.push({ from: nodes[i].id, fromPort: 'Out', to: nodes[i + 1].id, toPort: 'In' });
          }
          result.final_graph = { nodes, edges };
        }

        for (const node of result.final_graph?.nodes ?? []) {
          const nodeRef = ks.getNode(node.type);
          if (nodeRef) {
            result.node_zone_strategies[node.type] = {
              strategy: nodeRef.zone_strategy ?? 'none',
              position_params: nodeRef.position_params ?? [],
            };
          }
        }
      }

      break;
    }

    default: {
      return {
        content: [{ type: 'text', text: `Unknown step "${step}". Valid steps: start, followup, zones, finalize.` }],
        isError: true,
      };
    }
  }

  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}
