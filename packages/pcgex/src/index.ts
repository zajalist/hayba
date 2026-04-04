// mcp_server/src/index.ts
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config } from './config.js';
import { listCatalogResources, readCatalogResource } from './resources.js';
import { registerTools } from './tools/index.js';

const server = new McpServer({
  name: 'hayba-pcgex',
  version: '0.2.0'
});

// Register catalog resources
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

// Register tools
registerTools(server);

// Start MCP server over stdio
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`PCGEx Bridge MCP server v0.2.0 started on stdio`);
  console.error(`UE TCP target: ${config.ueTcpHost}:${config.ueTcpPort}`);
}

main().catch(console.error);
