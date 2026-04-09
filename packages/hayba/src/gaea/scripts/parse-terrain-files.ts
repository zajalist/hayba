import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export interface ParsedNode {
  id: string;
  type: string;
  params: Record<string, string | number | boolean>;
  position: { X: number; Y: number };
}

export interface ParsedEdge {
  from: string;
  fromPort: string;
  to: string;
  toPort: string;
}

export interface ParsedTerrain {
  source_file: string;
  metadata: { name: string; version: string };
  nodes: ParsedNode[];
  edges: ParsedEdge[];
}

/**
 * Extract the Gaea node type from the $type field.
 * Format: "QuadSpinner.Gaea.Nodes.RadialGradient, Gaea.Nodes"
 * Returns: "RadialGradient"
 */
function extractNodeType(typeStr: string): string {
  const parts = typeStr.split(',')[0].split('.');
  return parts[parts.length - 1];
}

/** Keys that are structural metadata, not terrain generation parameters */
const SKIP_KEYS = new Set([
  '$id', '$type', 'Id', 'Name', 'Position', 'Ports',
  'IsMarked', 'IsActive', 'IsPinned', 'IsBypassed', 'StateOverride',
  'DisplayMode', 'Notes', 'Color', 'GroupId', 'NodeSize',
  'PostProcessStack', 'ModifierStack', 'Modifiers',
]);

/**
 * Parse a single .terrain file (JSON format) into structured graph data.
 *
 * The .terrain format stores connections on input ports via a `Record` field:
 *   port.Record = { From: <numericId>, To: <numericId>, FromPort: string, ToPort: string }
 */
export function parseTerrainFile(filePath: string): ParsedTerrain {
  const raw = readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw);

  const terrain = data.Assets?.$values?.[0]?.Terrain ?? data;
  const metadata = {
    name: terrain.Metadata?.Name ?? path.basename(filePath, '.terrain'),
    version: terrain.Metadata?.Version ?? 'unknown',
  };

  const nodesObj = terrain.Nodes ?? {};
  const nodes: ParsedNode[] = [];
  const nodeIdMap = new Map<string, string>(); // numeric ID → typed ID

  for (const [numericId, nodeData] of Object.entries(nodesObj)) {
    if (numericId.startsWith('$')) continue;
    const nd = nodeData as Record<string, unknown>;

    const typeStr = nd.$type as string | undefined;
    if (!typeStr) continue;

    const type = extractNodeType(typeStr);
    const id = `${type}_${numericId}`;
    nodeIdMap.set(numericId, id);

    const position = nd.Position as { X?: number; Y?: number } | undefined;
    const pos = { X: position?.X ?? 0, Y: position?.Y ?? 0 };

    const params: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(nd)) {
      if (SKIP_KEYS.has(key)) continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        params[key] = value;
      }
    }

    nodes.push({ id, type, params, position: pos });
  }

  // Parse edges from input port Record connections
  const edges: ParsedEdge[] = [];
  const seen = new Set<string>();

  for (const [, nodeData] of Object.entries(nodesObj)) {
    const nd = nodeData as Record<string, unknown>;
    if (!nd.$type) continue;

    const ports = (nd.Ports as { $values?: unknown[] })?.$values ?? [];
    for (const port of ports) {
      const p = port as Record<string, unknown>;
      const portType = p.Type as string | undefined;
      const portName = p.Name as string | undefined;

      // Connections are on input ports via the Record field
      if (!portName || !portType) continue;
      if (!portType.includes('In')) continue;

      const record = p.Record as {
        From?: number; To?: number; FromPort?: string; ToPort?: string;
      } | undefined;

      if (!record?.From || !record?.To || !record?.FromPort || !record?.ToPort) continue;

      const fromId = nodeIdMap.get(String(record.From));
      const toId = nodeIdMap.get(String(record.To));
      if (!fromId || !toId) continue;

      const key = `${fromId}:${record.FromPort}→${toId}:${record.ToPort}`;
      if (seen.has(key)) continue;
      seen.add(key);

      edges.push({
        from: fromId,
        fromPort: record.FromPort,
        to: toId,
        toPort: record.ToPort,
      });
    }
  }

  return { source_file: path.basename(filePath), metadata, nodes, edges };
}

/**
 * Parse all .terrain files in a directory.
 */
export function parseAllTerrainFiles(dir: string): ParsedTerrain[] {
  const files = readdirSync(dir).filter(f => f.endsWith('.terrain'));
  return files.map(f => parseTerrainFile(path.join(dir, f)));
}

// CLI runner
const isCLI = process.argv[1]
  ? path.resolve(process.argv[1]).endsWith('parse-terrain-files.ts') ||
    path.resolve(process.argv[1]).endsWith('parse-terrain-files.js')
  : false;

if (isCLI) {
  const __dirnameResolved = path.dirname(fileURLToPath(import.meta.url));
  const examplesDir = path.resolve(__dirnameResolved, '../knowledge/more_examples');
  const outputDir = path.resolve(__dirnameResolved, '../knowledge/parsed-terrains');
  mkdirSync(outputDir, { recursive: true });

  const results = parseAllTerrainFiles(examplesDir);
  for (const result of results) {
    const slug = result.source_file.replace(/\.terrain$/, '').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
    writeFileSync(path.join(outputDir, `${slug}.json`), JSON.stringify(result, null, 2));
    console.log(`Parsed: ${result.source_file} → ${slug}.json (${result.nodes.length} nodes, ${result.edges.length} edges)`);
  }
  console.log(`\nDone. ${results.length} files parsed to ${outputDir}`);
}
