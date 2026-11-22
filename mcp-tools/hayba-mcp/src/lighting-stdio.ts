// Desktop's project-bound MCP server. The renderer never receives an editor socket.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import { UETcpClient, discoverPortFromInstanceRegistry } from './tcp-client.js';

async function main() {
  const project = process.argv[2];
  if (!project || !path.isAbsolute(project) || path.extname(project).toLowerCase() !== '.uproject')
    throw Error('Select an Unreal project.');
  const root = path.dirname(project);
  const port = discoverPortFromInstanceRegistry(root);
  if (!port) throw Error('Open the selected project with the Hayba plugin enabled.');
  const editor = new UETcpClient('127.0.0.1', port);
  await editor.connect();
  const server = new McpServer({ name: 'hayba-lighting', version: '1.0.0' });
  const ref = z.string().min(1).max(2048);
  const pair = { first: ref, second: ref };
  const value = z.number().finite();
  function register(name: string, description: string, inputSchema: Record<string, z.ZodType>) {
    server.registerTool(name, { description, inputSchema }, async (args) => {
      const identity = await editor.send('project_get_info', {}, 5000);
      if (
        !identity.ok ||
        typeof identity.data?.project_dir !== 'string' ||
        path.relative(root, identity.data.project_dir) !== '' ||
        String(identity.data.project_name).toLowerCase() !== path.basename(project, '.uproject').toLowerCase()
      )
        throw Error('The connected editor does not match the selected project.');
      const response = await editor.send(name, args as Record<string, unknown>, 10000);
      // The editor refuses the first write and includes the exact proposal to review.
      const reviewPending = name === 'lighting_set_intensity_checked' &&
        response.data?.status === 'plan_mode_required' &&
        response.data.approval_mode === 'exact_call_once' &&
        typeof response.data.proposal_id === 'string' && response.data.proposal_id.length > 0;
      if (!response.ok && !reviewPending) throw Error(String(response.error || 'Unreal could not complete this operation.'));
      return { content: [{ type: 'text', text: JSON.stringify(response.data) }] };
    });
  }
  register('lighting_list_loaded', 'List loaded editor light actors and their intensities.', {});
  register('lighting_inspect_pair', 'Read two distinct lights in the active editor world.', pair);
  register(
    'lighting_set_intensity_checked',
    'Set one intensity only if both inspected identities and values still match.',
    {
      ...pair,
      actor_id: ref,
      expected: value,
      other_expected: value,
      intensity: value.nonnegative(),
    },
  );
  register('lighting_review_status', 'Read the state of a specific Unreal lighting approval.', { proposal_id: ref });
  process.stdin.once('end', () => editor.disconnect());
  await server.connect(new StdioServerTransport());
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
