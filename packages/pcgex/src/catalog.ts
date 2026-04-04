// mcp_server/src/catalog.ts
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NodeCatalog, CatalogNode } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let catalog: NodeCatalog | null = null;

function getCatalogPath(): string {
  const candidates = [
    resolve(__dirname, '..', '..', 'Resources', 'node_catalog.json'),
    resolve(__dirname, '..', 'Resources', 'node_catalog.json'),
    resolve(__dirname, '..', '..', '..', 'Resources', 'node_catalog.json'),
  ];
  for (const p of candidates) {
    try {
      readFileSync(p, 'utf-8');
      return p;
    } catch {
      continue;
    }
  }
  throw new Error(`node_catalog.json not found. Checked: ${candidates.join(', ')}`);
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
              description: prop.tooltip || '',
              enum_values: prop.enum_values,
            })),
            common_patterns: [],
          });
        }
      }
    }
  }

  catalog = { version: raw._meta?.version_support?.[0] || '1.0', categories: categoryNames, nodes };
  return catalog;
}

export function searchCatalog(query: string): CatalogNode[] {
  const cat = loadCatalog();
  const q = query.toLowerCase();

  return cat.nodes.filter(node => {
    const searchable = [
      node.class,
      node.category,
      node.description,
      ...node.common_patterns,
      ...node.inputs.map(i => i.description || ''),
      ...node.outputs.map(o => o.pin),
      ...node.key_properties.map(p => p.name),
    ].join(' ').toLowerCase();

    return searchable.includes(q);
  });
}

export function getNodeByClass(className: string): CatalogNode | undefined {
  const cat = loadCatalog();
  return cat.nodes.find(n => n.class === className);
}

export function getNodesByCategory(category: string): CatalogNode[] {
  const cat = loadCatalog();
  return cat.nodes.filter(n => n.category.toLowerCase().includes(category.toLowerCase()));
}

export function getCategories(): string[] {
  return loadCatalog().categories;
}
