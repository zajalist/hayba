const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const path = require('node:path');

async function openLighting(project) {
  const client = new Client({ name: 'hayba-desktop', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, 'lighting-server.cjs'), project],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport, { timeout: 10000 });
    const { tools } = await client.listTools();
    if (!tools.some((t) => t.name === 'lighting_set_intensity_checked')) throw Error('Update the lighting server.');
  } catch {
    await client.close();
    throw Error(
      'Could not connect to Hayba MCP. Open the selected project in Unreal with the matching plugin installed.',
    );
  }
  return {
    close: () => client.close(),
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const text = result.content?.[0]?.text;
      if (result.isError || !text) throw Error(text || 'The editor did not return a result.');
      return JSON.parse(text);
    },
  };
}
module.exports = { openLighting };
