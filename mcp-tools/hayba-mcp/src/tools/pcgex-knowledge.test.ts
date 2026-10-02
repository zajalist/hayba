import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getPcgexKnowledgeDetail, searchPcgexKnowledge } from './pcgex-knowledge.js';
import { queryPcgexDocs } from './query-pcgex-docs.js';

const originalDir = process.env.HAYBA_PCGEX_KNOWLEDGE_DIR;
const originalCatalog = process.env.HAYBA_NODE_CATALOG;
const originalDb = process.env.HAYBA_PCGEX_DB;
const originalSource = process.env.HAYBA_PCGEX_SOURCE;
const dirs: string[] = [];
afterEach(() => {
  if (originalDir === undefined) delete process.env.HAYBA_PCGEX_KNOWLEDGE_DIR;
  else process.env.HAYBA_PCGEX_KNOWLEDGE_DIR = originalDir;
  if (originalCatalog === undefined) delete process.env.HAYBA_NODE_CATALOG;
  else process.env.HAYBA_NODE_CATALOG = originalCatalog;
  if (originalDb === undefined) delete process.env.HAYBA_PCGEX_DB;
  else process.env.HAYBA_PCGEX_DB = originalDb;
  if (originalSource === undefined) delete process.env.HAYBA_PCGEX_SOURCE;
  else process.env.HAYBA_PCGEX_SOURCE = originalSource;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hayba-knowledge-'));
  dirs.push(dir);
  process.env.HAYBA_PCGEX_KNOWLEDGE_DIR = dir;
  const put = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value));
  put('manifest.json', { bundle_schema: '2.1.0', generated: '2026-09-27', plugins: [
    { plugin: 'PCGExtendedToolkit', version: '0.79', file: 'core.json', entries: 1, concepts: 0 },
    { plugin: 'PCGExElementsClustersSketch', version: '0.1', file: 'sketch.json', entries: 2, concepts: 1, stale: 1 },
  ] });
  put('search.json', [
    { id: 'UPCGExStagingLoadSketchSettings', name: 'Staging : Load Sketch', plugin: 'PCGExElementsClustersSketch', kind: 'entry', classification: 'node', purpose: 'Print sketch assets onto target points', aliases: ['Load Sketch'] },
    { id: 'UPCGExClusterSketchCollection', name: 'Cluster Sketch Collection', plugin: 'PCGExElementsClustersSketch', kind: 'entry', classification: 'asset', purpose: 'A sketch collection asset' },
    { id: 'working-with-cluster-sketch/authoring', name: 'Authoring', plugin: 'PCGExElementsClustersSketch', kind: 'concept', outline: ['Two hosts, one panel'], purpose: 'Edit cluster sketches' },
  ]);
  put('core.json', { plugin: 'PCGExtendedToolkit', version: '0.79', aliases: {}, enums: {}, entries: {
    UPCGExSettings: { id: 'UPCGExSettings', name: 'Shared settings', plugin: 'PCGExtendedToolkit', classification: 'shared_struct', source: { file: 'Public/PCGExSettings.h', hash: 'abc' } },
  } });
  put('sketch.json', { plugin: 'PCGExElementsClustersSketch', version: '0.1', aliases: { FPCGExClusterSketchCollectionEntry: 'UPCGExClusterSketchCollection' }, enums: {}, entries: {
    UPCGExStagingLoadSketchSettings: { id: 'UPCGExStagingLoadSketchSettings', name: 'Staging : Load Sketch', plugin: 'PCGExElementsClustersSketch', classification: 'node', purpose: 'Print sketch assets onto target points', situation: 'Distribute assets', mechanism: { text: 'Print once and duplicate' }, pins: { inputs: [{ label: 'Targets', required: 'always' }], outputs: [{ label: 'Vtx' }] }, settings: { GraphBuilderDetails: { display: 'Cluster Output Settings', type: 'FPCGExGraphBuilderDetails', see: 'UPCGExSettings' } }, inherits: ['UPCGExSettings'], source: { file: 'Public/PCGExStagingLoadSketch.h', hash: '123', stale: true } },
    UPCGExClusterSketchCollection: { id: 'UPCGExClusterSketchCollection', name: 'Cluster Sketch Collection', plugin: 'PCGExElementsClustersSketch', classification: 'asset', purpose: 'A sketch collection asset', source: { file: 'Public/Collection.h', hash: '456' } },
  } });
  put('concepts.json', [{ id: 'working-with-cluster-sketch/authoring', title: 'Authoring', plugin: 'PCGExElementsClustersSketch', path: 'authoring.md', body: 'Use the panel to edit sketches.' }]);
  return { dir, put };
}

describe('optional PCGExKnowledge bundle', () => {
  it('searches entry and concept rows, preserving provenance and placeability', () => {
    fixture();
    const result = searchPcgexKnowledge('sketch');
    expect(result.available).toBe(true);
    expect(result.results).toHaveLength(3);
    expect(result.results.find(r => r.id === 'UPCGExStagingLoadSketchSettings')).toMatchObject({ placeableInPcgGraph: true, documentedPluginVersion: '0.1', manifestStaleEntries: 1 });
    expect(result.results.find(r => r.id === 'UPCGExClusterSketchCollection')).toMatchObject({ classification: 'asset', placeableInPcgGraph: false });
    expect(result.results.find(r => r.kind === 'concept')).toMatchObject({ placeableInPcgGraph: false });
  });

  it('resolves aliases and cross-plugin inherits/see references', () => {
    fixture();
    expect(searchPcgexKnowledge('FPCGExClusterSketchCollectionEntry')).toMatchObject({ available: true, results: [{ id: 'UPCGExClusterSketchCollection', requestedId: 'FPCGExClusterSketchCollectionEntry' }] });
    expect(getPcgexKnowledgeDetail('FPCGExClusterSketchCollectionEntry')).toMatchObject({ found: true, id: 'UPCGExClusterSketchCollection', resolvedAlias: 'FPCGExClusterSketchCollectionEntry', placeableInPcgGraph: false });
    expect(getPcgexKnowledgeDetail('UPCGExStagingLoadSketchSettings')).toMatchObject({
      found: true, sourceStale: true, sourceHash: '123', documentedPluginVersion: '0.1',
      references: [{ requestedId: 'UPCGExSettings', id: 'UPCGExSettings', plugin: 'PCGExtendedToolkit' }, { requestedId: 'UPCGExSettings', id: 'UPCGExSettings', plugin: 'PCGExtendedToolkit' }],
    });
  });

  it('returns concept prose by exact plugin-qualified id', () => {
    fixture();
    expect(getPcgexKnowledgeDetail('PCGExElementsClustersSketch:working-with-cluster-sketch/authoring')).toMatchObject({ kind: 'concept', body: 'Use the panel to edit sketches.' });
  });

  it('keeps knowledge hits when a requested local header snippet is unavailable', async () => {
    fixture();
    expect(await queryPcgexDocs({ query: 'UPCGExStagingLoadSketchSettings', includeSourceSnippet: true })).toMatchObject({
      available: true, results: [{ id: 'UPCGExStagingLoadSketchSettings', sourceSnippetUnavailable: true }],
    });
  });

  it('reports missing, invalid, and unsupported bundles without a network request', () => {
    const { dir, put } = fixture();
    expect(searchPcgexKnowledge('sketch').available).toBe(true);
    put('manifest.json', { bundle_schema: '3.0.0', generated: '2026-09-27', plugins: [] });
    expect(searchPcgexKnowledge('sketch')).toMatchObject({ available: false, results: [] });
    rmSync(dir, { recursive: true, force: true });
    expect(getPcgexKnowledgeDetail('UPCGExSettings')).toMatchObject({ available: false });
  });

  it('rejects plugin file traversal and mismatched versions', () => {
    const { put } = fixture();
    put('manifest.json', { bundle_schema: '2.1.0', generated: '2026-09-27', plugins: [{ plugin: 'PCGExtendedToolkit', version: '0.79', file: '../outside.json', entries: 1, concepts: 0 }] });
    expect(searchPcgexKnowledge('sketch').available).toBe(false);
    const next = fixture();
    next.put('sketch.json', { plugin: 'PCGExElementsClustersSketch', version: '0.2', aliases: {}, enums: {}, entries: {} });
    expect(getPcgexKnowledgeDetail('UPCGExStagingLoadSketchSettings')).toMatchObject({ available: false });
  });

  it('keeps the offline catalog fallback when the bundle is invalid', async () => {
    const { dir, put } = fixture();
    process.env.HAYBA_NODE_CATALOG = join(dir, 'node_catalog.json');
    put('node_catalog.json', { version: '1.0', categories: ['Test'], nodes: [{ class: 'UPCGExExampleSettings', category: 'Test', description: 'Example fallback', inputs: [], outputs: [], key_properties: [], common_patterns: [] }] });
    put('manifest.json', { bundle_schema: '3.0.0', generated: '2026-09-27', plugins: [] });
    expect(await queryPcgexDocs({ query: 'UPCGExExampleSettings', includeSourceSnippet: false })).toMatchObject({ results: [{ class: 'UPCGExExampleSettings', description: 'Example fallback' }] });
  });

  it('merges matching knowledge provenance and staleness into a catalog result with its local snippet', async () => {
    const { dir, put } = fixture();
    process.env.HAYBA_NODE_CATALOG = join(dir, 'node_catalog.json');
    process.env.HAYBA_PCGEX_DB = join(dir, 'pcgex_registry.db');
    put('node_catalog.json', { version: '1.0', categories: ['Test'], nodes: [{
      class: 'UPCGExStagingLoadSketchSettings', category: 'Test', description: 'Local catalog fact',
      inputs: [], outputs: [], key_properties: [], common_patterns: [],
    }] });
    const source = join(dir, 'Source');
    const publicDir = join(source, 'PCGExElementsClustersSketch', 'Public');
    mkdirSync(publicDir, { recursive: true });
    process.env.HAYBA_PCGEX_SOURCE = source;
    const header = join(publicDir, 'PCGExStagingLoadSketch.h');
    writeFileSync(header, 'class UPCGExStagingLoadSketchSettings {};\n');
    const db = new DatabaseSync(process.env.HAYBA_PCGEX_DB);
    db.exec('CREATE TABLE nodes (class TEXT, display_name TEXT, description TEXT, header_path TEXT); CREATE TABLE pins (node_class TEXT, name TEXT, direction TEXT, type TEXT, required INTEGER); CREATE TABLE properties (node_class TEXT, property_name TEXT, cpp_type TEXT)');
    db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?)').run('UPCGExStagingLoadSketchSettings', 'Load Sketch', 'Local DB fact', 'PCGExElementsClustersSketch/Public/PCGExStagingLoadSketch.h');
    db.close();
    vi.resetModules(); // DB_PATH and catalog path are captured when the module loads.
    const { queryPcgexDocs: freshQuery } = await import('./query-pcgex-docs.js');
    expect(await freshQuery({ query: 'UPCGExStagingLoadSketchSettings', includeSourceSnippet: true })).toMatchObject({
      results: [{
        class: 'UPCGExStagingLoadSketchSettings', description: 'Local catalog fact',
        sourceSnippet: 'class UPCGExStagingLoadSketchSettings {};\n',
        knowledge: { detailId: 'UPCGExStagingLoadSketchSettings', classification: 'node', placeableInPcgGraph: true,
          source: 'PCGExKnowledge', documentedPluginVersion: '0.1', generated: '2026-09-27',
          manifestStaleEntries: 1, sourceHash: '123', sourceStale: true },
      }],
    });

    delete process.env.HAYBA_PCGEX_SOURCE;
    expect(await freshQuery({ query: 'UPCGExStagingLoadSketchSettings', includeSourceSnippet: true })).toMatchObject({
      results: [{ class: 'UPCGExStagingLoadSketchSettings', sourceSnippetUnavailable: true }],
    });
  });

  it('rejects absolute and traversal registry paths even with a local source configured', async () => {
    const { dir } = fixture();
    process.env.HAYBA_NODE_CATALOG = join(dir, 'missing-catalog.json');
    process.env.HAYBA_PCGEX_DB = join(dir, 'pcgex_registry.db');
    const source = join(dir, 'Source');
    mkdirSync(source);
    process.env.HAYBA_PCGEX_SOURCE = source;
    const publicDir = join(source, 'PCGExSafety', 'Public');
    mkdirSync(publicDir, { recursive: true });
    writeFileSync(join(publicDir, 'PCGExSafe.h'), 'class UPCGExSafeSettings {};\n');
    const outside = join(dir, 'outside.h');
    writeFileSync(outside, 'class UPCGExUnsafeSettings {};\n');
    const db = new DatabaseSync(process.env.HAYBA_PCGEX_DB);
    db.exec('CREATE TABLE nodes (class TEXT, display_name TEXT, description TEXT, header_path TEXT); CREATE TABLE pins (node_class TEXT, name TEXT, direction TEXT, type TEXT, required INTEGER); CREATE TABLE properties (node_class TEXT, property_name TEXT, cpp_type TEXT)');
    db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?)').run('UPCGExTraversalSettings', 'Traversal', 'Unsafe path', '../outside.h');
    db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?)').run('UPCGExAbsoluteSettings', 'Absolute', 'Unsafe path', outside);
    db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?)').run('UPCGExSafeSettings', 'Safe', 'Local metadata', 'PCGExSafety/Public/PCGExSafe.h');
    db.prepare('INSERT INTO pins VALUES (?, ?, ?, ?, ?)').run('UPCGExSafeSettings', 'Input', 'input', 'point', 1);
    db.close();
    vi.resetModules();
    const { queryPcgexDocs: freshQuery } = await import('./query-pcgex-docs.js');
    for (const className of ['UPCGExTraversalSettings', 'UPCGExAbsoluteSettings']) {
      const result = await freshQuery({ query: className, includeSourceSnippet: true });
      expect(result).toMatchObject({ results: [{ class: className, sourceSnippetUnavailable: true }] });
      expect(JSON.stringify(result)).not.toContain(outside);
    }
    expect(await freshQuery({ query: 'UPCGExSafeSettings', includeSourceSnippet: true })).toMatchObject({
      results: [{ class: 'UPCGExSafeSettings', sourceSnippet: 'class UPCGExSafeSettings {};\n' }],
    });
    delete process.env.HAYBA_PCGEX_SOURCE;
    expect(await freshQuery({ query: 'UPCGExSafeSettings', includeSourceSnippet: true })).toMatchObject({
      results: [{ class: 'UPCGExSafeSettings', description: 'Local metadata',
        pins: [{ pin: 'Input', direction: 'input', type: 'point', required: true }],
        sourceSnippetUnavailable: true }],
    });
  });
});
