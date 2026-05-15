import { z } from 'zod';
import { searchCatalog, getNodesByCategory, getCategories } from '../catalog.js';

const schema = z.object({
  query: z.string().min(1).describe('Search query — keyword, node class name, or category name')
});

export type SearchNodeCatalogParams = z.infer<typeof schema>;

export async function searchNodeCatalog(params: SearchNodeCatalogParams) {
  const { query } = schema.parse(params);

  const categories = getCategories();
  const categoryMatch = categories.find(c => c.toLowerCase() === query.toLowerCase());
  if (categoryMatch) {
    return { results: getNodesByCategory(categoryMatch), matchType: 'category' };
  }

  const results = searchCatalog(query);
  return { results, matchType: 'keyword' };
}
