import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { KnowledgeStore } from '../gaea/knowledge/knowledge-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = resolve(__dirname, '..', 'gaea', 'knowledge', 'gaea-docs');

let store: KnowledgeStore | null = null;
function getStore(): KnowledgeStore {
  if (!store) store = new KnowledgeStore(DOCS_DIR);
  return store;
}

export interface QueryGaeaKnowledgeParams {
  node_type?: string;
  phase?: string;
  query?: string;
}

export async function queryGaeaKnowledge(params: QueryGaeaKnowledgeParams): Promise<Record<string, unknown>> {
  const s = getStore();
  const result: Record<string, unknown> = {};

  if (params.node_type) {
    result.node = s.getNode(params.node_type);
    result.neighbors = s.getNodeNeighbors(params.node_type);
  }

  if (params.phase || params.query) {
    result.bestPractices = s.getBestPractices({
      phase: params.phase,
      nodeTypes: params.node_type ? [params.node_type] : undefined,
    });
    result.patterns = s.findPatterns({
      phase: params.phase,
      description: params.query,
    });
  }

  if (!params.node_type && !params.phase && !params.query) {
    result.availableNodes = s.nodeTypes;
  }

  return result;
}
