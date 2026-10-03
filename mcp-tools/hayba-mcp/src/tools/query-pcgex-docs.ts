import { z } from 'zod';
import { getPcgexKnowledgeDetail, searchPcgexKnowledge } from './pcgex-knowledge.js';
import { searchCatalog, getNodeByClass } from '../catalog.js';
import { readFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const schema = z.object({
  query: z.string().min(1).describe('Node class name or keyword to search documentation'),
  includeSourceSnippet: z.boolean().optional().default(false).describe('Include up to 80 lines from the header file'),
});

export type QueryPcgexDocsParams = z.infer<typeof schema>;

import { config } from '../config.js';
const DB_PATH = config.pcgexDbPath;

interface DocResult {
  class: string;
  displayName: string;
  description: string;
  pins: Array<{ pin: string; direction: string; type: string; required?: boolean }>;
  properties: Array<{ name: string; type: string; default?: string; description?: string }>;
  sourceSnippet?: string;
  sourceSnippetUnavailable?: boolean;
  knowledge?: {
    detailId: string;
    classification: string;
    placeableInPcgGraph: boolean;
    source: string;
    plugin: string;
    bundleSchema: string;
    generated: string;
    documentedPluginVersion: string | null;
    manifestStaleEntries: number;
    sourceHash: string;
    sourceStale: boolean;
    note: string;
  };
  _headerPath?: string;
}

function isDbAvailable(): boolean {
  try {
    return existsSync(DB_PATH);
  } catch {
    return false;
  }
}

function getDbResults(query: string): DocResult[] {
  let db: InstanceType<typeof DatabaseSync> | undefined;
  try {
    if (!isDbAvailable()) return [];
    // DatabaseSync opens on construction; close after reading the result rows.
    const opened = new DatabaseSync(DB_PATH);
    db = opened;
    const nodes = opened.prepare(
      `SELECT * FROM nodes WHERE class LIKE ? OR display_name LIKE ?`
    ).all(`%${query}%`, `%${query}%`) as Array<{ class: string; display_name: string; description: string; header_path: string }>;

    const results: DocResult[] = nodes.map(n => {
      const pins = opened.prepare(`SELECT * FROM pins WHERE node_class = ?`).all(n.class) as Array<{
        name: string; direction: string; type: string; required: number;
      }>;
      const properties = opened.prepare(`SELECT * FROM properties WHERE node_class = ?`).all(n.class) as Array<{
        property_name: string; cpp_type: string;
      }>;
      return {
        class: n.class,
        displayName: n.display_name,
        description: n.description,
        pins: pins.map(p => ({ pin: p.name, direction: p.direction, type: p.type, required: p.required === 1 })),
        properties: properties.map(p => ({ name: p.property_name, type: p.cpp_type })),
        _headerPath: n.header_path,
      };
    });
    return results;
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function getSourceSnippet(headerPath: string, className: string): string | undefined {
  // Registry paths are metadata relative to PCGExtendedToolkit/Source. The
  // packaged DB never grants permission to read an arbitrary local file.
  const configuredSource = process.env.HAYBA_PCGEX_SOURCE?.trim();
  if (!configuredSource || isAbsolute(headerPath) || win32.isAbsolute(headerPath)) return undefined;
  const parts = headerPath.replace(/\\/g, '/').split('/');
  if (parts.length < 3 || !['Public', 'Private'].includes(parts[1]) || !parts.at(-1)?.endsWith('.h') ||
      parts.some(part => !part || part === '.' || part === '..' || part.includes(':'))) return undefined;
  try {
    const sourceRoot = realpathSync(configuredSource);
    if (!statSync(sourceRoot).isDirectory()) return undefined;
    const candidate = resolve(sourceRoot, ...parts);
    if (!isWithin(sourceRoot, candidate)) return undefined;
    // Resolve the file too, so a symlink under Source cannot escape the root.
    const actualHeader = realpathSync(candidate);
    if (!isWithin(sourceRoot, actualHeader) || !statSync(actualHeader).isFile()) return undefined;
    const lines = readFileSync(actualHeader, 'utf-8').split('\n');
    const classLine = lines.findIndex(l => l.includes(className));
    if (classLine === -1) return undefined;
    return lines.slice(Math.max(0, classLine - 5), Math.min(lines.length, classLine + 75)).join('\n');
  } catch {
    return undefined;
  }
}

function addSourceSnippet(result: DocResult, headerPath: string | undefined): void {
  const snippet = headerPath ? getSourceSnippet(headerPath, result.class) : undefined;
  if (snippet !== undefined) result.sourceSnippet = snippet;
  else result.sourceSnippetUnavailable = true;
}

export async function queryPcgexDocs(params: QueryPcgexDocsParams) {
  const { query, includeSourceSnippet } = schema.parse(params);
  const knowledge = searchPcgexKnowledge(query);
  if (!includeSourceSnippet && knowledge.available && knowledge.results.length) return knowledge;
  const results: DocResult[] = [];

  // 1. Try exact class match in catalog
  let exactNode;
  try { exactNode = getNodeByClass(query); } catch { /* catalog is optional */ }
  if (exactNode) {
    results.push({
      class: exactNode.class,
      displayName: exactNode.class,
      description: exactNode.description,
      pins: [
        ...exactNode.inputs.map(p => ({ pin: p.pin, direction: 'input', type: p.type, required: p.required })),
        ...exactNode.outputs.map(p => ({ pin: p.pin, direction: 'output', type: p.type })),
      ],
      properties: exactNode.key_properties.map(p => ({ name: p.name, type: p.type, default: p.default, description: p.description })),
    });
  }

  // 2. Keyword search in catalog
  if (results.length === 0) {
    let catalogResults: ReturnType<typeof searchCatalog> = [];
    try { catalogResults = searchCatalog(query).slice(0, 5); } catch { /* try registry DB */ }
    for (const node of catalogResults) {
      results.push({
        class: node.class,
        displayName: node.class,
        description: node.description,
        pins: [
          ...node.inputs.map(p => ({ pin: p.pin, direction: 'input', type: p.type, required: p.required })),
          ...node.outputs.map(p => ({ pin: p.pin, direction: 'output', type: p.type })),
        ],
        properties: node.key_properties.map(p => ({ name: p.name, type: p.type, default: p.default, description: p.description })),
      });
    }
  }

  // 3. Fall back to registry DB
  if (results.length === 0) {
    const dbResults = getDbResults(query).slice(0, 5);
    for (const r of dbResults) {
      const { _headerPath, ...rest } = r;
      results.push(rest);
      if (includeSourceSnippet) addSourceSnippet(results[results.length - 1], _headerPath);
    }
  } else if (includeSourceSnippet) {
    // BUG-7: flag when snippet unavailable (DB absent)
    const dbAvailable = isDbAvailable();
    if (!dbAvailable) {
      for (const result of results) {
        result.sourceSnippetUnavailable = true;
      }
    } else {
      const dbResults = getDbResults(query);
      for (const result of results) {
        const dbMatch = dbResults.find(d => d.class === result.class);
        addSourceSnippet(result, dbMatch?._headerPath);
      }
    }
  }

  if (results.length === 0 && knowledge.available && knowledge.results.length) {
    return { ...knowledge, results: knowledge.results.map(result => ({ ...result, sourceSnippetUnavailable: true })) };
  }
  if (knowledge.available) {
    for (const result of results) {
      const detail = getPcgexKnowledgeDetail(result.class);
      if ('kind' in detail && detail.kind === 'entry' && detail.found &&
          'classification' in detail && 'placeableInPcgGraph' in detail &&
          'sourceHash' in detail && 'sourceStale' in detail) {
        result.knowledge = {
          detailId: detail.id,
          classification: String(detail.classification),
          placeableInPcgGraph: detail.placeableInPcgGraph,
          source: detail.source,
          plugin: detail.plugin,
          bundleSchema: detail.bundleSchema,
          generated: detail.generated,
          documentedPluginVersion: detail.documentedPluginVersion,
          manifestStaleEntries: detail.manifestStaleEntries,
          sourceHash: detail.sourceHash,
          sourceStale: detail.sourceStale,
          note: detail.note,
        };
      }
    }
  }
  return { results: results.map(r => { const { _headerPath, ...rest } = r; return rest; }) };
}
