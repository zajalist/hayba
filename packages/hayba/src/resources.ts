// mcp_server/src/resources.ts
import { loadCatalog, getNodesByCategory, getCategories } from './catalog.js';

export async function listCatalogResources(): Promise<
  Array<{ uri: string; name: string; description: string; mimeType: string }>
> {
  const categories = getCategories();
  return categories.map(cat => ({
    uri: `pcgex://catalog/${encodeURIComponent(cat)}`,
    name: `PCGEx Nodes: ${cat}`,
    description: `Curated catalog of PCGEx nodes in the ${cat} category`,
    mimeType: 'application/json'
  }));
}

export async function readCatalogResource(category: string): Promise<string> {
  const nodes = getNodesByCategory(decodeURIComponent(category));
  if (nodes.length === 0) {
    throw new Error(`No nodes found in category: ${category}`);
  }
  return JSON.stringify(nodes, null, 2);
}
