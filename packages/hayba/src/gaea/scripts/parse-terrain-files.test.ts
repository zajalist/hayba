import { describe, it, expect } from 'vitest';
import { parseTerrainFile, type ParsedTerrain } from './parse-terrain-files.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = path.resolve(__dirname, '../knowledge/more_examples');

describe('parseTerrainFile', () => {
  it('parses Snowymount.terrain into nodes and edges', () => {
    const filePath = path.join(EXAMPLES_DIR, 'Snowymount.terrain');
    const result = parseTerrainFile(filePath);

    expect(result.source_file).toBe('Snowymount.terrain');
    expect(result.nodes.length).toBeGreaterThan(0);

    for (const node of result.nodes) {
      expect(node.id).toBeTruthy();
      expect(node.type).toBeTruthy();
      expect(typeof node.params).toBe('object');
      expect(node.position).toBeDefined();
      expect(typeof node.position.X).toBe('number');
      expect(typeof node.position.Y).toBe('number');
    }

    // Edges should reference existing node IDs
    const nodeIds = new Set(result.nodes.map(n => n.id));
    for (const edge of result.edges) {
      expect(nodeIds.has(edge.from)).toBe(true);
      expect(nodeIds.has(edge.to)).toBe(true);
      expect(edge.fromPort).toBeTruthy();
      expect(edge.toPort).toBeTruthy();
    }
  });

  it('extracts edges from port Record connections', () => {
    const filePath = path.join(EXAMPLES_DIR, 'Snowymount.terrain');
    const result = parseTerrainFile(filePath);
    // Snowymount has connections — edges array should be non-empty
    expect(result.edges.length).toBeGreaterThan(0);
  });

  it('extracts metadata (name, version)', () => {
    const filePath = path.join(EXAMPLES_DIR, 'Snowymount.terrain');
    const result = parseTerrainFile(filePath);
    expect(result.metadata.name).toBeDefined();
    expect(typeof result.metadata.name).toBe('string');
    expect(result.metadata.version).toBeDefined();
  });

  it('node types are clean names without namespace prefix', () => {
    const filePath = path.join(EXAMPLES_DIR, 'Snowymount.terrain');
    const result = parseTerrainFile(filePath);
    for (const node of result.nodes) {
      expect(node.type).not.toContain('QuadSpinner');
      expect(node.type).not.toContain('Gaea.Nodes');
    }
  });
});
