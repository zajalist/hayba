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
}
