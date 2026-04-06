// mcp_server/src/tools/index.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { searchNodeCatalog } from './search-node-catalog.js';
import { getNodeDetails } from './get-node-details.js';
import { createPcgGraph } from './create-pcg-graph.js';
import { validatePcgGraph } from './validate-pcg-graph.js';
import { listPcgAssets } from './list-pcg-assets.js';
import { exportPcgGraph } from './export-pcg-graph.js';
import { executePcgGraph } from './execute-pcg-graph.js';
import { checkUeStatus } from './check-ue-status.js';
import { scrapeNodeRegistry } from './scrape-node-registry.js';
import { matchPinNames } from './match-pin-names.js';
import { validateAttributeFlow } from './validate-attribute-flow.js';
import { diffAgainstWorkingAsset } from './diff-against-working-asset.js';
import { formatGraphTopology } from './format-graph-topology.js';
import { abstractToSubgraph } from './abstract-to-subgraph.js';
import { parameterizeGraphInputs } from './parameterize-graph-inputs.js';
import { queryPcgexDocs } from './query-pcgex-docs.js';
import { initiateInfrastructureBrainstorm } from './initiate-infrastructure-brainstorm.js';

export function registerTools(server: McpServer): void {
  server.tool(
    'search_node_catalog',
    { query: z.string().describe('Search query — keyword, node class, or category') },
    async ({ query }) => {
      const result = await searchNodeCatalog({ query });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'get_node_details',
    { class: z.string().describe('PCGEx node class name') },
    async (params) => {
      const result = await getNodeDetails({ class: params.class });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'create_pcg_graph',
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
    'validate_pcg_graph',
    { graph: z.string().describe('JSON string of the PCGEx graph to validate') },
    async ({ graph }) => {
      const result = await validatePcgGraph({ graph });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'list_pcg_assets',
    { path: z.string().optional().describe('Content path filter (default: /Game/)') },
    async ({ path }) => {
      const result = await listPcgAssets({ path });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'export_pcg_graph',
    { assetPath: z.string().describe('Full UE asset path to the PCGGraph') },
    async ({ assetPath }) => {
      const result = await exportPcgGraph({ assetPath });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'execute_pcg_graph',
    { assetPath: z.string().describe('Full UE asset path to execute') },
    async ({ assetPath }) => {
      const result = await executePcgGraph({ assetPath });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'check_ue_status',
    {},
    async () => {
      const result = await checkUeStatus();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Phase A tools ────────────────────────────────────────────────────────────

  server.tool(
    'scrape_node_registry',
    {
      pluginSourcePath: z.string().optional().describe('Path to PCGExtendedToolkit/Source/ directory'),
      outputDbPath: z.string().optional().describe('Output SQLite DB path (default: Resources/pcgex_registry.db)'),
      forceRescan: z.boolean().optional().describe('Force re-scan even if DB exists'),
    },
    async (params) => {
      const result = await scrapeNodeRegistry(params as any);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'match_pin_names',
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
    'validate_attribute_flow',
    {
      graph: z.string().describe('JSON string of the PCGEx graph to validate attribute flow'),
      strictMode: z.boolean().optional().describe('If true, also flag orphan writes (written but never consumed)'),
    },
    async (params) => {
      const result = await validateAttributeFlow(params as any);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'diff_against_working_asset',
    {
      wipGraph: z.string().describe('JSON string of the work-in-progress graph'),
      referenceAssetPath: z.string().describe('Full UE asset path to the reference PCGGraph'),
      diffMode: z.enum(['structural', 'properties', 'full']).optional().describe('What to diff (default: full)'),
    },
    async (params) => {
      const result = await diffAgainstWorkingAsset(params as any);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'format_graph_topology',
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
      const result = await formatGraphTopology(params as any);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  server.tool(
    'abstract_to_subgraph',
    {
      graph: z.string().describe('JSON string of the full PCGEx graph'),
      nodeIds: z.array(z.string()).describe('Array of node IDs to extract into a subgraph'),
      subgraphName: z.string().optional().describe('Name for the extracted subgraph (default: SubGraph)'),
    },
    async (params) => {
      const result = await abstractToSubgraph(params as any);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'parameterize_graph_inputs',
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
    'query_pcgex_docs',
    {
      query: z.string().describe('Node class name or keyword to search documentation'),
      includeSourceSnippet: z.boolean().optional().default(false).describe('Include up to 80 lines from the header file'),
    },
    async (params) => {
      const result = await queryPcgexDocs(params as any);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'initiate_infrastructure_brainstorm',
    'Plan complex graph architectures. IMPORTANT: After calling this tool, do NOT call create_pcg_graph, validate_pcg_graph, or any graph-mutation tool until the user explicitly approves an approach from the proposal.',
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
            '\n\n---\nIMPORTANT: This is a PROPOSAL ONLY. Do NOT call create_pcg_graph, ' +
            'validate_attribute_flow, abstract_to_subgraph, or any graph-mutation tool ' +
            'until the user has explicitly approved an approach above.',
        }]
      };
    }
  );
}
