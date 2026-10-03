import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { loadCatalog, parseCatalogData } from '../catalog.js';
import type { CatalogNode, NodeCatalog, NodePin } from '../types.js';

const CONCEPTS = [
  ['road', 'roads', 'route', 'routes', 'routing', 'path', 'paths', 'spline', 'network'],
  ['scatter', 'scattering', 'sample', 'sampling', 'distribute', 'distribution', 'points'],
  ['terrain', 'landscape', 'ground', 'surface', 'mesh'],
  ['cluster', 'clusters', 'graph', 'edges', 'vertices', 'network'],
  ['refine', 'refinement', 'filter', 'prune', 'simplify', 'minimum', 'spanning'],
  ['generate', 'generation', 'build', 'create', 'emit', 'produce', 'sample'],
] as const;

const STOP_WORDS = new Set(['a', 'an', 'and', 'for', 'of', 'on', 'the', 'to', 'with']);

function words(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter(word => !STOP_WORDS.has(word)) ?? [];
}

function semanticVector(text: string): Map<string, number> {
  const vector = new Map<string, number>();
  for (const word of words(text)) {
    vector.set(word, (vector.get(word) ?? 0) + 1);
    for (const [index, concept] of CONCEPTS.entries()) {
      if (concept.includes(word as never)) {
        const key = `concept:${index}`;
        vector.set(key, (vector.get(key) ?? 0) + 1);
      }
    }
  }
  return vector;
}

function cosine(left: Map<string, number>, right: Map<string, number>): number {
  let dot = 0;
  let leftLength = 0;
  let rightLength = 0;
  for (const value of left.values()) leftLength += value * value;
  for (const [key, value] of right) {
    rightLength += value * value;
    dot += value * (left.get(key) ?? 0);
  }
  if (dot === 0 || leftLength === 0 || rightLength === 0) return 0;
  return dot / Math.sqrt(leftLength * rightLength);
}

function nodeText(node: CatalogNode): string {
  return [
    node.class,
    node.category,
    node.description,
    ...node.common_patterns,
    ...node.inputs.flatMap(pin => [pin.pin, pin.type, pin.description ?? '']),
    ...node.outputs.flatMap(pin => [pin.pin, pin.type, pin.description ?? '']),
    ...node.key_properties.flatMap(property => [property.name, property.type, property.description ?? '']),
  ].join(' ');
}

export interface SemanticNodeResult {
  node: CatalogNode;
  score: number;
}

export function searchNodeCatalogSemantic(
  nodes: CatalogNode[],
  query: string,
  k = 10,
): SemanticNodeResult[] {
  const queryVector = semanticVector(query);
  return nodes
    .map(node => ({ node, score: cosine(queryVector, semanticVector(nodeText(node))) }))
    .filter(result => result.score > 0)
    .sort((a, b) => b.score - a.score || a.node.class.localeCompare(b.node.class))
    .slice(0, k);
}

function normalizeType(type: string): string {
  return type.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/data$/, '').replace(/s$/, '');
}

function findClass(nodes: CatalogNode[], className: string): CatalogNode | undefined {
  const wanted = className.replace(/^U/, '').toLowerCase();
  return nodes.find(node => node.class.replace(/^U/, '').toLowerCase() === wanted);
}

export interface CompatiblePin {
  node_class: string;
  pin: string;
  type: string;
  compatibility: 'exact' | 'wildcard';
}

export function compatiblePins(
  nodes: CatalogNode[],
  fromClass: string,
  fromPin: string,
): CompatiblePin[] {
  const source = findClass(nodes, fromClass);
  if (!source) throw new Error(`PCG node class '${fromClass}' is not in the catalog`);
  const output = source.outputs.find(pin => pin.pin.toLowerCase() === fromPin.toLowerCase());
  if (!output) throw new Error(`Output pin '${fromPin}' is not defined on '${source.class}'`);
  const outputType = normalizeType(output.type);

  return nodes
    .flatMap(node => node.inputs.flatMap((input): CompatiblePin[] => {
      const inputType = normalizeType(input.type);
      if (inputType === 'any') {
        return [{ node_class: node.class, pin: input.pin, type: input.type, compatibility: 'wildcard' }];
      }
      if (inputType !== outputType) return [];
      return [{ node_class: node.class, pin: input.pin, type: input.type, compatibility: 'exact' }];
    }))
    .sort((a, b) => {
      const compatibility = a.compatibility.localeCompare(b.compatibility);
      return compatibility || a.node_class.localeCompare(b.node_class) || a.pin.localeCompare(b.pin);
    });
}

interface PatternTemplate {
  id: string;
  intent: string;
  use_when: string;
  nodes: Array<{ id: string; class: string }>;
  edges: Array<{ from: string; from_pin: string; to: string; to_pin: string }>;
}

type CatalogStatus = 'confirmed' | 'absent' | 'unknown';

interface TemplatePreflight {
  catalog_version: string | null;
  scope: 'catalog_only';
  requiresLiveValidation: true;
  note: string;
  class_checks: Array<{ id: string; class: string; status: CatalogStatus }>;
  pin_checks: Array<{ node: string; direction: 'input' | 'output'; pin: string; status: CatalogStatus }>;
  edge_checks: Array<PatternTemplate['edges'][number] & {
    status: CatalogStatus;
    type_compatibility: 'compatible' | 'incompatible' | 'unknown';
  }>;
}

function catalogPinStatus(node: CatalogNode | undefined, direction: 'input' | 'output', pin: string): CatalogStatus {
  if (!node) return 'unknown';
  const pins = direction === 'input' ? node.inputs : node.outputs;
  if (pins.some(candidate => candidate.pin.toLowerCase() === pin.toLowerCase() && !/[()]/.test(candidate.pin))) return 'confirmed';
  // Scraped PCGEx nodes can declare pins dynamically; an empty or expression-like
  // list does not prove a pin is absent in a live editor.
  if (pins.length === 0 || pins.some(candidate => /[()]/.test(candidate.pin))) return 'unknown';
  return 'absent';
}

export function preflightPatternTemplate(template: PatternTemplate, catalog?: NodeCatalog): TemplatePreflight {
  const byId = new Map(template.nodes.map(node => [node.id, catalog && findClass(catalog.nodes, node.class)]));
  const class_checks = template.nodes.map(node => ({
    id: node.id,
    class: node.class,
    status: (byId.get(node.id) ? 'confirmed' : catalog ? 'absent' : 'unknown') as CatalogStatus,
  }));
  const pin_checks = template.edges.flatMap(edge => [
    { node: edge.from, direction: 'output' as const, pin: edge.from_pin,
      status: catalogPinStatus(byId.get(edge.from), 'output', edge.from_pin) },
    { node: edge.to, direction: 'input' as const, pin: edge.to_pin,
      status: catalogPinStatus(byId.get(edge.to), 'input', edge.to_pin) },
  ]);
  const edge_checks = template.edges.map((edge, index) => {
    const statuses = [pin_checks[index * 2].status, pin_checks[index * 2 + 1].status];
    const output = byId.get(edge.from)?.outputs.find(pin => pin.pin.toLowerCase() === edge.from_pin.toLowerCase());
    const input = byId.get(edge.to)?.inputs.find(pin => pin.pin.toLowerCase() === edge.to_pin.toLowerCase());
    const outputType = output && normalizeType(output.type);
    const inputType = input && normalizeType(input.type);
    const type_compatibility: 'compatible' | 'incompatible' | 'unknown' = statuses.every(status => status === 'confirmed') && outputType && inputType
      ? (inputType === 'any' || outputType === 'any' || inputType === outputType ? 'compatible' : 'incompatible')
      : 'unknown';
    const status: CatalogStatus = statuses.includes('absent') ? 'absent'
      : statuses.includes('unknown') || type_compatibility !== 'compatible' ? 'unknown' : 'confirmed';
    return { ...edge, status, type_compatibility };
  });
  return {
    catalog_version: catalog?.version ?? null,
    scope: 'catalog_only',
    requiresLiveValidation: true,
    note: catalog
      ? 'Catalog checks do not establish which plugins, classes, or dynamic pins exist in the live editor. Validate the graph and cook in Unreal before use.'
      : 'Catalog unavailable; all checks are unknown. Validate classes, pins, graph connections, and cook in Unreal before use.',
    class_checks,
    pin_checks,
    edge_checks,
  };
}

const PATTERNS: PatternTemplate[] = [
  {
    id: 'road-network',
    intent: 'road roads route routing path paths settlement network spline',
    use_when: 'Use this when routing roads or paths between seed locations over a cluster.',
    nodes: [
      { id: 'delaunay', class: 'UPCGExBuildDelaunayGraph2DSettings' },
      { id: 'pathfind', class: 'UPCGExPathfindingEdgesSettings' },
      { id: 'spline', class: 'UPCGExCreateSplineSettings' },
    ],
    edges: [
      { from: 'delaunay', from_pin: 'Edges', to: 'pathfind', to_pin: 'Cluster' },
      { from: 'pathfind', from_pin: 'Paths', to: 'spline', to_pin: 'Paths' },
    ],
  },
  {
    id: 'surface-scatter',
    intent: 'scatter distribute sample terrain landscape surface mesh foliage points',
    use_when: 'Use this when distributing points or meshes across a terrain or surface.',
    nodes: [
      { id: 'sample', class: 'UPCGSurfaceSamplerSettings' },
      { id: 'transform', class: 'UPCGTransformPointsSettings' },
      { id: 'spawn', class: 'UPCGStaticMeshSpawnerSettings' },
    ],
    edges: [
      { from: 'sample', from_pin: 'Points', to: 'transform', to_pin: 'In' },
      { from: 'transform', from_pin: 'Out', to: 'spawn', to_pin: 'In' },
    ],
  },
  {
    id: 'cluster-refinement',
    intent: 'cluster graph edge edges refine refinement minimum spanning tree simplify prune',
    use_when: 'Use this when reducing or refining a generated cluster before downstream path operations.',
    nodes: [
      { id: 'cluster', class: 'UPCGExBuildDelaunayGraph2DSettings' },
      { id: 'refine', class: 'UPCGExRefineEdgesSettings' },
    ],
    edges: [{ from: 'cluster', from_pin: 'Edges', to: 'refine', to_pin: 'Cluster' }],
  },
];

export function getPatternTemplate(intent: string, catalog?: NodeCatalog | null): (PatternTemplate & { preflight: TemplatePreflight }) | { template: null; available: string[] } {
  const query = semanticVector(intent);
  const ranked = PATTERNS
    .map(template => ({ template, score: cosine(query, semanticVector(template.intent)) }))
    .sort((a, b) => b.score - a.score || a.template.id.localeCompare(b.template.id));
  if (!ranked[0] || ranked[0].score === 0) {
    return { template: null, available: PATTERNS.map(pattern => pattern.id) };
  }
  const template = ranked[0].template;
  let availableCatalog = catalog ?? undefined;
  if (catalog === undefined) {
    try {
      availableCatalog = loadCatalog();
    } catch {
      // Template discovery remains available when the optional catalog is missing.
    }
  }
  return { ...template, preflight: preflightPatternTemplate(template, availableCatalog) };
}

const NODE_FIELDS = [
  'category',
  'description',
  'inputs',
  'outputs',
  'key_properties',
  'common_patterns',
] as const satisfies readonly (keyof CatalogNode)[];

function stable(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify([...value].sort((a, b) => stable(a).localeCompare(stable(b))));
  if (value && typeof value === 'object') {
    return JSON.stringify(Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, JSON.parse(stable(child))]),
    ));
  }
  return JSON.stringify(value);
}

export function diffCatalogs(before: NodeCatalog, after: NodeCatalog) {
  const previous = new Map(before.nodes.map(node => [node.class, node]));
  const current = new Map(after.nodes.map(node => [node.class, node]));
  const added = [...current.keys()].filter(className => !previous.has(className)).sort();
  const removed = [...previous.keys()].filter(className => !current.has(className)).sort();
  const modified = [...current.keys()]
    .filter(className => previous.has(className))
    .map(className => ({
      class: className,
      fields: NODE_FIELDS.filter(field => stable(previous.get(className)![field]) !== stable(current.get(className)![field])),
    }))
    .filter(change => change.fields.length > 0)
    .sort((a, b) => a.class.localeCompare(b.class));
  return {
    from_version: before.version,
    to_version: after.version,
    added,
    removed,
    modified,
  };
}

function parseCatalog(path: string): NodeCatalog {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const parsed = parseCatalogData(raw);
  if (parsed.nodes.length === 0) throw new Error(`Catalog '${path}' contains no nodes`);
  return parsed;
}

export const semanticSearchSchema = z.object({
  query: z.string().min(1),
  k: z.number().int().min(1).max(50).optional().default(10),
});

export async function semanticSearchHandler(params: z.input<typeof semanticSearchSchema>) {
  const { query, k } = semanticSearchSchema.parse(params);
  return { query, results: searchNodeCatalogSemantic(loadCatalog().nodes, query, k) };
}

export const compatiblePinsSchema = z.object({
  from_class: z.string().min(1),
  from_pin: z.string().min(1),
});

export async function compatiblePinsHandler(params: z.input<typeof compatiblePinsSchema>) {
  const { from_class, from_pin } = compatiblePinsSchema.parse(params);
  return { from_class, from_pin, matches: compatiblePins(loadCatalog().nodes, from_class, from_pin) };
}

export const patternTemplateSchema = z.object({ intent: z.string().min(1) });

export async function patternTemplateHandler(params: z.input<typeof patternTemplateSchema>) {
  const { intent } = patternTemplateSchema.parse(params);
  return getPatternTemplate(intent);
}

export const catalogDiffSchema = z.object({ baseline_path: z.string().min(1) });

export async function catalogDiffHandler(params: z.input<typeof catalogDiffSchema>) {
  const { baseline_path } = catalogDiffSchema.parse(params);
  return diffCatalogs(parseCatalog(baseline_path), loadCatalog());
}
