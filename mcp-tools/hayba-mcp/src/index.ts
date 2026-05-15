// mcp_server/src/index.ts
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config } from './config.js';
import { listCatalogResources, readCatalogResource } from './resources.js';
import { registerTools } from './tools/index.js';
import { startDashboard } from './dashboard/server.js';

// ── MCP server setup ─────────────────────────────────────────────────────────
const server = new McpServer({
  name: 'hayba-mcp',
  version: '1.0.0'
});

// Register catalog resources (PCGEx node catalog)
const catalogTemplate = new ResourceTemplate('pcgex://catalog/{category}', {
  list: async () => {
    const resources = await listCatalogResources();
    return { resources: resources.map(r => ({ uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType })) };
  }
});

server.resource('pcgex_catalog', catalogTemplate, async (uri, { category }) => {
  const content = await readCatalogResource(category as string);
  return {
    contents: [{ uri: uri.href, mimeType: 'application/json', text: content }]
  };
});

// Register all tools. The legacy SessionManager arg is a typed-shim no-op until
// the worldbuilding-hub roadmap reaches the terrain integration phase.
registerTools(server, {});

// ── Start ─────────────────────────────────────────────────────────────────────
async function main() {
  await startDashboard(config.dashboardPort, '127.0.0.1');
  console.error(`Dashboard: http://127.0.0.1:${config.dashboardPort}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Hayba MCP Toolkit v1.0.0 started on stdio`);
  console.error(`UE TCP target: ${config.ueTcpHost}:${config.ueTcpPort}`);
}

main().catch(console.error);
