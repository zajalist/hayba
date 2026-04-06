import type { ToolHandler } from './hayba-bake-terrain.js';
import { GraphSchema } from '../gaea/types.js';
import { getTemplate, listTemplates } from '../gaea/templates/index.js';

export const createTerrainHandler: ToolHandler = async (args, session) => {
  if (typeof args.prompt !== 'string' || !args.prompt.trim()) {
    return { content: [{ type: 'text', text: 'Error: prompt is required and must be a non-empty string' }], isError: true };
  }

  const resolution = (args.resolution as number) ?? 1024;
  const outputDir = (args.output_dir as string) ?? session.outputDir;

  if (typeof args.template === 'string') {
    const overrides = (args.template_overrides as Record<string, unknown>) ?? {};
    const graph = getTemplate(args.template, overrides);
    if (!graph) {
      const available = listTemplates().map(t => `  - ${t.name}: ${t.description}`).join('\n');
      return {
        content: [{ type: 'text', text: `Unknown template "${args.template}". Available templates:\n${available}` }],
        isError: true
      };
    }
    args.graph = graph;
  }

  if (args.graph) {
    const validation = GraphSchema.safeParse(args.graph);
    if (!validation.success) {
      return {
        content: [{ type: 'text', text: `Graph validation failed: ${validation.error.message}` }],
        isError: true
      };
    }

    await session.enqueue(async () => { await session.client.createGraph(validation.data); });
    const terrainPath = session.client.currentTerrainPath;

    let exported: { heightmap: string; normalmap?: string; splatmap?: string } | null = null;
    let cookError: string | null = null;
    try {
      await session.enqueue(async () => { await session.client.cook(); });
      exported = await session.enqueue(() =>
        session.client.export(outputDir, resolution > 1024 ? 'EXR' : 'PNG')
      );
    } catch (e) { cookError = (e as Error).message; }

    if (terrainPath) session.setTerrainPath(terrainPath);

    if (exported) {
      const lines = [
        `Terrain generated and cooked successfully.`,
        `Prompt: "${args.prompt}"`,
        ``,
        `Output files:`,
        `  Heightmap: ${exported.heightmap}`,
        exported.normalmap ? `  Normal map: ${exported.normalmap}` : null,
        exported.splatmap  ? `  Splatmap: ${exported.splatmap}` : null,
        ``,
        `You can call hayba_get_graph_state to inspect the graph.`
      ].filter(Boolean).join('\n');
      return { content: [{ type: 'text', text: lines }] };
    }

    const lines = [
      `Terrain graph created successfully.`,
      `Prompt: "${args.prompt}"`,
      terrainPath ? `\nTerrain file: ${terrainPath}` : ``,
      `\nNote: Cooking/export failed — open the .terrain file in Gaea to cook manually.`,
      cookError ? `  Error: ${cookError}` : ``,
      ``,
      `You can call hayba_get_graph_state to inspect the graph.`
    ].filter(Boolean).join('\n');
    return { content: [{ type: 'text', text: lines }] };
  }

  const nodeTypes = await session.enqueue(() => session.client.listNodeTypes());
  const catalog = nodeTypes
    .map((n) => {
      const params = n.parameters.map((p) => `  - ${p.name}: ${p.type} [${p.min ?? '?'} - ${p.max ?? '?'}], default ${p.default}`).join('\n');
      return `### ${n.type} (${n.category})\nInputs: ${n.inputs.join(', ') || 'none'} | Outputs: ${n.outputs.join(', ')}\n${params}`;
    })
    .join('\n\n');

  const templates = listTemplates();
  const templateSection = [
    `## Quick Start: Use a Template`,
    `If you cannot build a full graph, use a template instead:`,
    ...templates.map(t => `  - **${t.name}**: ${t.description} (tweakable: ${(t.tweakable ?? []).join(', ')})`),
    ``,
    `Call: hayba_create_terrain(prompt="...", template="desert", template_overrides={"Seed": 42})`,
    ``,
    `## Advanced: Build a Custom Graph`
  ].join('\n');

  return {
    content: [{
      type: 'text',
      text: [
        templateSection,
        ``,
        `No graph provided. Please build a graph JSON and call again with the "graph" parameter.`,
        ``,
        `The graph must have: { "nodes": [...], "edges": [...] }`,
        `Each node: { "id": "unique_id", "type": "NodeType", "params": { ... } }`,
        `Each edge: { "from": "node_id", "fromPort": "port", "to": "node_id", "toPort": "port" }`,
        ``,
        `Available nodes:`,
        ``,
        catalog,
        ``,
        `Prompt to fulfill: "${args.prompt}"`
      ].join('\n')
    }]
  };
};
