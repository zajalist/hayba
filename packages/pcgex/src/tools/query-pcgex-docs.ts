import { z } from 'zod';
import { searchCatalog, getNodeByClass } from '../catalog.js';
import { readFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const schema = z.object({
  query: z.string().min(1).describe('Node class name or keyword to search documentation'),
  includeSourceSnippet: z.boolean().optional().default(false).describe('Include up to 80 lines from the header file'),
});

export type QueryPcgexDocsParams = z.infer<typeof schema>;

const DB_PATH = 'D:/UnrealEngine/geoforge/Plugins/Hayba_PcgEx_MCP/Resources/pcgex_registry.db';

interface DocResult {
  class: string;
  displayName: string;
  description: string;
  pins: Array<{ pin: string; direction: string; type: string; required?: boolean }>;
  properties: Array<{ name: string; type: string; default?: string; description?: string }>;
  sourceSnippet?: string;
  sourceSnippetUnavailable?: boolean;
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
  try {
    // BUG-8: DatabaseSync API — just new DatabaseSync(path), no open/close methods
    const db = new DatabaseSync(DB_PATH);
    const nodes = db.prepare(
      `SELECT * FROM nodes WHERE class LIKE ? OR display_name LIKE ?`
    ).all(`%${query}%`, `%${query}%`) as Array<{ class: string; display_name: string; description: string; header_path: string }>;

    const results: DocResult[] = nodes.map(n => {
      const pins = db.prepare(`SELECT * FROM pins WHERE node_class = ?`).all(n.class) as Array<{
        name: string; direction: string; type: string; required: number;
      }>;
      const properties = db.prepare(`SELECT * FROM properties WHERE node_class = ?`).all(n.class) as Array<{
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
  }
}

function getSourceSnippet(headerPath: string, className: string): string {
  try {
    const lines = readFileSync(headerPath, 'utf-8').split('\n');
    const classLine = lines.findIndex(l => l.includes(className));
    if (classLine === -1) return '';
    return lines.slice(Math.max(0, classLine - 5), Math.min(lines.length, classLine + 75)).join('\n');
  } catch {
    return '';
  }
}

export async function queryPcgexDocs(params: QueryPcgexDocsParams) {
  const { query, includeSourceSnippet } = schema.parse(params);
  const results: DocResult[] = [];

  // 1. Try exact class match in catalog
  const exactNode = getNodeByClass(query);
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
    const catalogResults = searchCatalog(query).slice(0, 5);
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
      if (includeSourceSnippet && _headerPath) {
        results[results.length - 1].sourceSnippet = getSourceSnippet(_headerPath, r.class);
      }
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
        if (dbMatch?._headerPath) {
          result.sourceSnippet = getSourceSnippet(dbMatch._headerPath, result.class);
        } else {
          result.sourceSnippetUnavailable = true;
        }
      }
    }
  }

  return { results: results.map(r => { const { _headerPath, ...rest } = r; return rest; }) };
}
