// mcp_server/src/catalog.ts
import { existsSync, readFileSync } from 'node:fs';
import type { NodeCatalog, CatalogNode } from './types.js';
import { config } from './config.js';

let catalog: NodeCatalog | null = null;

function getCatalogPath(): string {
  const p = config.catalogPath;
  if (!existsSync(p)) {
    throw new Error(
      `node_catalog.json not found at "${p}". ` +
      `Set HAYBA_NODE_CATALOG to override, or place the file at ` +
      `<workspace>/packages/hayba/Plugins/HaybaMCPToolkit/Resources/node_catalog.json. ` +
      `Run hayba_scrape_node_registry against your PCGExtendedToolkit source to (re)generate the registry DB.`
    );
  }
  return p;
}

/**
 * Load the catalog JSON and flatten its nested categories structure
 * into the flat NodeCatalog format used by the rest of the codebase.
 */
export function loadCatalog(): NodeCatalog {
  if (catalog) return catalog;
  const path = getCatalogPath();
  const raw = JSON.parse(readFileSync(path, 'utf-8'));

  // The JSON has: { categories: { "Name": { description, nodes: [...] } } }
  // Each node has: class, display_name, description, input_pins, output_pins, properties
  // We flatten into: { categories: string[], nodes: CatalogNode[] }

  const categoryNames: string[] = [];
  const nodes: CatalogNode[] = [];

  if (raw.categories && typeof raw.categories === 'object') {
    for (const [catName, catData] of Object.entries(raw.categories as Record<string, any>)) {
      categoryNames.push(catName);
      if (Array.isArray(catData.nodes)) {
        for (const rawNode of catData.nodes) {
          nodes.push({
            class: rawNode.class || '',
            category: catName,
            description: rawNode.description || rawNode.display_name || '',
            inputs: (rawNode.input_pins || []).map((p: any) => ({
              pin: p.name,
              type: p.type || 'Any',
              required: p.required || false,
              description: p.tooltip || '',
            })),
            outputs: (rawNode.output_pins || []).map((p: any) => ({
              pin: p.name,
              type: p.type || 'Any',
              description: p.tooltip || '',
            })),
            key_properties: Object.entries(rawNode.properties || {}).map(([name, prop]: [string, any]) => ({
              name,
              type: prop.type || 'unknown',
              default: prop.default !== undefined ? String(prop.default) : undefined,
              // Accept either `tooltip` (legacy hand-authored catalog) or
              // `description` (scrape-node-registry output).
              description: prop.tooltip || prop.description || '',
              enum_values: prop.enum_values,
            })),
            common_patterns: [],
          });
        }
      }
    }
  }

  catalog = { version: raw._meta?.version_support?.[0] || '1.0', categories: categoryNames, nodes };

  // Warm the search text now, while the JSON parse has already made this call
  // slow, rather than making the first agent lookup pay for the whole corpus.
  for (const node of nodes) haystackFor(node);

  return catalog;
}

/**
 * Pure, catalog-independent node search.
 *
 * The query is tokenized on whitespace and matched with AND semantics: a node
 * matches when EVERY token is a substring of its joined searchable text
 * (class + category + description + patterns + pin/property names).
 *
 * Previously this did `searchable.includes(query)` on the *whole* query, which
 * silently returned `[]` for any multi-word query (e.g. "Delaunay 2D cluster")
 * because the literal phrase never appears contiguously in the joined text.
 * Single-token queries are unaffected (one token => identical to the old
 * `includes` behavior).
 */
/**
 * Per-node searchable text, built once and reused.
 *
 * Before this cache, every query rebuilt the haystack for every node — a fresh
 * array (spreading patterns and mapping over pins/properties), a `join`, and a
 * `toLowerCase` of the whole corpus, per lookup, against a ~650 KB catalog.
 * `loadCatalog()` was memoized but the text it implied was not, so search cost
 * scaled with the corpus on every call instead of once per process.
 *
 * A WeakMap keyed on the node keeps `searchNodes` usable as a pure function on
 * arbitrary arrays (tests pass literals) while still paying the build cost at
 * most once per node. Entries die with the nodes, so a re-loaded catalog does
 * not leak the old one's strings.
 *
 * The one caveat, pinned by a test: a node mutated *after* it has been searched
 * keeps its old searchable text. Catalog nodes are built once by `loadCatalog`
 * and never edited, so this costs nothing today — but anything that starts
 * rewriting a node in place must drop it from this cache, and there is no way
 * for the cache to notice on its own.
 */
const haystacks = new WeakMap<CatalogNode, string>();

function haystackFor(node: CatalogNode): string {
  const cached = haystacks.get(node);
  if (cached !== undefined) return cached;

  const built = [
    node.class,
    node.category,
    node.description,
    ...node.common_patterns,
    ...node.inputs.map(i => i.description || ''),
    ...node.outputs.map(o => o.pin),
    ...node.key_properties.map(p => p.name),
  ].join(' ').toLowerCase();

  haystacks.set(node, built);
  return built;
}

export function searchNodes(nodes: CatalogNode[], query: string): CatalogNode[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  return nodes.filter(node => {
    const searchable = haystackFor(node);
    return terms.every(term => searchable.includes(term));
  });
}

export function searchCatalog(query: string): CatalogNode[] {
  return searchNodes(loadCatalog().nodes, query);
}

export function getNodeByClass(className: string): CatalogNode | undefined {
  const cat = loadCatalog();
  // Try exact match first, then with/without leading 'U' prefix
  return (
    cat.nodes.find(n => n.class === className) ??
    cat.nodes.find(n => n.class === `U${className}`) ??
    cat.nodes.find(n => n.class === className.replace(/^U/, ''))
  );
}

export function getNodesByCategory(category: string): CatalogNode[] {
  const cat = loadCatalog();
  return cat.nodes.filter(n => n.category.toLowerCase().includes(category.toLowerCase()));
}

export function getCategories(): string[] {
  return loadCatalog().categories;
}
