import path from 'path';
import { fileURLToPath } from 'url';
import { ArchetypeStore } from '../gaea/knowledge/archetype-store.js';
import type { SearchInput } from '../gaea/knowledge/types.js';

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

export function reloadArchetypeStore(): void {
  store = null;
}

export async function searchGaeaArchetypes(params: SearchInput) {
  const s = getStore();
  const results = await s.search(params);
  return {
    count: results.length,
    archetypes: results,
  };
}
