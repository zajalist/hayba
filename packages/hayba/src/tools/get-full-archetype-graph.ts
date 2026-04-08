import path from 'path';
import { fileURLToPath } from 'url';
import { ArchetypeStore } from '../gaea/knowledge/archetype-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = path.resolve(__dirname, '../gaea/knowledge');
const INDEX_PATH = path.join(KNOWLEDGE_DIR, 'archetypes.json');
const EMBEDDINGS_PATH = path.join(KNOWLEDGE_DIR, 'embeddings.json');
const GRAPHS_DIR = path.join(KNOWLEDGE_DIR, 'full-graphs');

let store: ArchetypeStore | null = null;

function getStore(): ArchetypeStore {
  if (!store) {
    store = new ArchetypeStore(INDEX_PATH, EMBEDDINGS_PATH, GRAPHS_DIR);
  }
  return store;
}

export async function getFullArchetypeGraph(params: { pattern_name: string }) {
  const s = getStore();
  const result = s.getFullGraph(params.pattern_name);
  if (!result) {
    return { error: `No full graph found for pattern "${params.pattern_name}". The archetype may exist in the light index but has no associated graph JSON file.` };
  }
  return result;
}
