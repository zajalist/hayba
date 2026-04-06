import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SessionManager } from '../gaea/session.js';

// ── PCGEx tool handlers ───────────────────────────────────────────────────────
import { searchNodeCatalog } from './search-node-catalog.js';
import { getNodeDetails } from './get-node-details.js';
import { createPcgGraph } from './create-pcg-graph.js';
import { validatePcgGraph } from './validate-pcg-graph.js';
import { listPcgAssets } from './list-pcg-assets.js';
import { exportPcgGraph } from './export-pcg-graph.js';
import { executePcgGraph } from './execute-pcg-graph.js';
import { checkUeStatus } from './check-ue-status.js';
import { scrapeNodeRegistry, type ScrapeNodeRegistryParams } from './scrape-node-registry.js';
import { matchPinNames } from './match-pin-names.js';
import { validateAttributeFlow, type ValidateAttributeFlowParams } from './validate-attribute-flow.js';
import { diffAgainstWorkingAsset, type DiffAgainstWorkingAssetParams } from './diff-against-working-asset.js';
import { formatGraphTopology, type FormatGraphTopologyParams } from './format-graph-topology.js';
import { abstractToSubgraph, type AbstractToSubgraphParams } from './abstract-to-subgraph.js';
import { parameterizeGraphInputs } from './parameterize-graph-inputs.js';
import { queryPcgexDocs, type QueryPcgexDocsParams } from './query-pcgex-docs.js';
import { initiateInfrastructureBrainstorm } from './initiate-infrastructure-brainstorm.js';

// ── Gaea tool handlers ────────────────────────────────────────────────────────
import { bakeTerrain } from './hayba-bake-terrain.js';
import { createTerrainHandler } from './hayba-create-terrain.js';
import { openInGaeaTool } from './hayba-open-in-gaea.js';
import { readTerrainVariablesTool } from './hayba-read-terrain-variables.js';
import { setTerrainVariablesTool } from './hayba-set-terrain-variables.js';
import { openSessionHandler } from './hayba-open-session.js';
import { closeSessionHandler } from './hayba-close-session.js';
import { addNodeHandler } from './hayba-add-node.js';
import { removeNodeHandler } from './hayba-remove-node.js';
import { connectNodesHandler } from './hayba-connect-nodes.js';
import { getGraphStateHandler } from './hayba-get-graph-state.js';
import { getParametersHandler } from './hayba-get-parameters.js';
import { setParameterHandler } from './hayba-set-parameter.js';
import { listNodeTypesHandler } from './hayba-list-node-types.js';
import { cookGraphHandler } from './hayba-cook-graph.js';

export function registerTools(server: McpServer, session: SessionManager): void {

  // ── PCGEx tools ─────────────────────────────────────────────────────────────

  server.tool(
    'hayba_search_node_catalog',
    { query: z.string().describe('Search query — keyword, node class, or category') },
    async ({ query }) => {
      const result = await searchNodeCatalog({ query });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_get_node_details',
    { class: z.string().describe('PCGEx node class name') },
    async (params) => {
      const result = await getNodeDetails({ class: params.class });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_create_pcg_graph',
    {
      graph: z.string().describe('JSON string of the PCGEx graph topology'),
      name: z.string().describe('Asset name for the new PCGGraph')
    },
    async ({ graph, name }) => {
      const result = await createPcgGraph({ graph, name });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_validate_pcg_graph',
    { graph: z.string().describe('JSON string of the PCGEx graph to validate') },
    async ({ graph }) => {
      const result = await validatePcgGraph({ graph });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_list_pcg_assets',
    { path: z.string().optional().describe('Content path filter (default: /Game/)') },
    async ({ path }) => {
      const result = await listPcgAssets({ path });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_export_pcg_graph',
    { assetPath: z.string().describe('Full UE asset path to the PCGGraph') },
    async ({ assetPath }) => {
      const result = await exportPcgGraph({ assetPath });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_execute_pcg_graph',
    { assetPath: z.string().describe('Full UE asset path to execute') },
    async ({ assetPath }) => {
      const result = await executePcgGraph({ assetPath });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_check_ue_status',
    {},
    async () => {
      const result = await checkUeStatus();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_scrape_node_registry',
    {
      pluginSourcePath: z.string().optional().describe('Path to PCGExtendedToolkit/Source/ directory'),
      outputDbPath: z.string().optional().describe('Output SQLite DB path (default: Resources/pcgex_registry.db)'),
      forceRescan: z.boolean().optional().describe('Force re-scan even if DB exists'),
    },
    async (params) => {
      const result = await scrapeNodeRegistry(params as unknown as ScrapeNodeRegistryParams);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_match_pin_names',
    {
      fromClass: z.string().describe('Source node class'),
      fromPin: z.string().describe('Pin name on source node (may be approximate)'),
      toClass: z.string().describe('Target node class to find a matching input pin on'),
    },
    async (params) => {
      const result = await matchPinNames(params);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_validate_attribute_flow',
    {
      graph: z.string().describe('JSON string of the PCGEx graph to validate attribute flow'),
      strictMode: z.boolean().optional().describe('If true, also flag orphan writes (written but never consumed)'),
    },
    async (params) => {
      const result = await validateAttributeFlow(params as unknown as ValidateAttributeFlowParams);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_diff_against_working_asset',
    {
      wipGraph: z.string().describe('JSON string of the work-in-progress graph'),
      referenceAssetPath: z.string().describe('Full UE asset path to the reference PCGGraph'),
      diffMode: z.enum(['structural', 'properties', 'full']).optional().describe('What to diff (default: full)'),
    },
    async (params) => {
      const result = await diffAgainstWorkingAsset(params as unknown as DiffAgainstWorkingAssetParams);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_format_graph_topology',
    {
      graph: z.string().describe(
        'JSON string of the PCGEx graph to layout. ' +
        'NOTE: UE5 uses integer NodePosX/NodePosY, top-left origin, positive Y downward.'
      ),
      algorithm: z.enum(['layered', 'grid']).optional().describe('Layout algorithm (default: layered)'),
      nodeWidth: z.number().int().optional().describe('Node width in pixels (default: 200)'),
      nodeHeight: z.number().int().optional().describe('Node height in pixels (default: 100)'),
      horizontalSpacing: z.number().int().optional().describe('Horizontal gap between layers (default: 150)'),
      verticalSpacing: z.number().int().optional().describe('Vertical gap between rows (default: 80)'),
      addCommentBlocks: z.boolean().optional().describe('Wrap category clusters in PCGComment nodes'),
    },
    async (params) => {
      const result = await formatGraphTopology(params as unknown as FormatGraphTopologyParams);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  server.tool(
    'hayba_abstract_to_subgraph',
    {
      graph: z.string().describe('JSON string of the full PCGEx graph'),
      nodeIds: z.array(z.string()).describe('Array of node IDs to extract into a subgraph'),
      subgraphName: z.string().optional().describe('Name for the extracted subgraph (default: SubGraph)'),
    },
    async (params) => {
      const result = await abstractToSubgraph(params as unknown as AbstractToSubgraphParams);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_parameterize_graph_inputs',
    {
      graph: z.string().describe('JSON string of the PCGEx graph'),
      targets: z.array(z.object({
        nodeId: z.string().describe('Node ID containing the hardcoded property'),
        property: z.string().describe('Property name to parameterize'),
        parameterName: z.string().optional().describe('Name for the graph parameter'),
      })).describe('List of properties to promote to graph parameters'),
    },
    async (params) => {
      const result = await parameterizeGraphInputs(params);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_query_pcgex_docs',
    {
      query: z.string().describe('Node class name or keyword to search documentation'),
      includeSourceSnippet: z.boolean().optional().default(false).describe('Include up to 80 lines from the header file'),
    },
    async (params) => {
      const result = await queryPcgexDocs(params as unknown as QueryPcgexDocsParams);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_initiate_infrastructure_brainstorm',
    'Plan complex graph architectures. IMPORTANT: After calling this tool, do NOT call hayba_create_pcg_graph, hayba_validate_pcg_graph, or any graph-mutation tool until the user explicitly approves an approach from the proposal.',
    {
      topic: z.string().describe('The infrastructure or system design topic to brainstorm'),
      context: z.string().optional().describe('Additional context about the project or constraints'),
      constraints: z.array(z.string()).optional().describe('Explicit constraints or requirements'),
    },
    async (params) => {
      const result = await initiateInfrastructureBrainstorm(params);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2) +
            '\n\n---\nIMPORTANT: This is a PROPOSAL ONLY. Do NOT call hayba_create_pcg_graph, ' +
            'hayba_validate_attribute_flow, hayba_abstract_to_subgraph, or any graph-mutation tool ' +
            'until the user has explicitly approved an approach above.',
        }]
      };
    }
  );

  // ── Gaea tools ───────────────────────────────────────────────────────────────

  server.tool(
    'hayba_bake_terrain',
    {
      path: z.string().optional().describe('Absolute path to the .terrain file (uses loaded terrain if omitted)'),
      variables: z.record(z.unknown()).optional().describe('Variable overrides to inject as -v key=value flags'),
      ignorecache: z.boolean().optional().describe('Force full re-bake ignoring cache (default: true)'),
    },
    async (params) => {
      const result = await bakeTerrain(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_create_terrain',
    {
      prompt: z.string().describe('Natural language terrain description'),
      template: z.string().optional().describe('Predefined terrain template: desert, mountains, tropical, volcanic'),
      template_overrides: z.record(z.unknown()).optional().describe('Override specific template parameters'),
      graph: z.unknown().optional().describe('Full Gaea node graph JSON with nodes and edges arrays'),
      output_dir: z.string().optional().describe('Output directory (uses config default if omitted)'),
      resolution: z.number().optional().describe('Output heightmap resolution: 1024, 2048, or 4096 (default: 1024)'),
    },
    async (params) => {
      const result = await createTerrainHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_open_in_gaea',
    { path: z.string().optional().describe('Absolute path to the .terrain file (uses current terrain if omitted)') },
    async (params) => {
      const result = await openInGaeaTool(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_read_terrain_variables',
    { path: z.string().optional().describe('Absolute path to the .terrain file (uses current terrain if omitted)') },
    async (params) => {
      const result = await readTerrainVariablesTool(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_set_terrain_variables',
    {
      path: z.string().optional().describe('Absolute path to the .terrain file (uses current terrain if omitted)'),
      contract: z.record(z.unknown()).describe('Variable contract: keys are variable names, values define type/default/min/max'),
      values: z.record(z.unknown()).optional().describe('Values to write; missing keys use contract defaults'),
    },
    async (params) => {
      const result = await setTerrainVariablesTool(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_open_session',
    { path: z.string().describe('Absolute path to the .terrain file to open') },
    async (params) => {
      const result = await openSessionHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_close_session',
    {},
    async () => {
      const result = await closeSessionHandler({}, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_add_node',
    {
      type: z.string().describe('Node type, e.g. "Mountain", "Erosion2". Call hayba_list_node_types to see options.'),
      id: z.string().describe('Unique name for this node, e.g. "peaks", "erode"'),
      params: z.record(z.unknown()).optional().describe('Optional parameter overrides'),
      position: z.object({ X: z.number(), Y: z.number() }).optional(),
    },
    async (params) => {
      const result = await addNodeHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_remove_node',
    { id: z.string().describe('Node id to remove') },
    async (params) => {
      const result = await removeNodeHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_connect_nodes',
    {
      from_id: z.string().describe('Source node id'),
      from_port: z.string().describe('Source port, e.g. "Out"'),
      to_id: z.string().describe('Target node id'),
      to_port: z.string().describe('Target port, e.g. "In"'),
    },
    async (params) => {
      const result = await connectNodesHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_get_graph_state',
    {},
    async () => {
      const result = await getGraphStateHandler({}, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_get_parameters',
    { node_id: z.string().describe('Node id as shown in hayba_get_graph_state') },
    async (params) => {
      const result = await getParametersHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_set_parameter',
    {
      node_id: z.string(),
      parameter: z.string().describe('Parameter name as returned by hayba_get_parameters'),
      value: z.union([z.string(), z.number(), z.boolean()]).describe('New value within valid range'),
    },
    async (params) => {
      const result = await setParameterHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_list_node_types',
    { category: z.string().optional().describe('Filter by category, e.g. "erosion", "primitives"') },
    async (params) => {
      const result = await listNodeTypesHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_cook_graph',
    { nodes: z.array(z.string()).optional().describe('Node ids for partial re-cook; omit for full cook') },
    async (params) => {
      const result = await cookGraphHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );
}
