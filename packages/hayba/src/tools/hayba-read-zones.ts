import type { ToolResult } from './hayba-bake-terrain.js';
import { getCurrentZones } from '../zones.js';
import { DEFAULT_PROJECTS_BASE } from '../projects.js';

export async function readZonesHandler(
  args: Record<string, unknown>,
  base = DEFAULT_PROJECTS_BASE,
): Promise<ToolResult> {
  const projectId = args.projectId as string | undefined;
  if (!projectId) {
    return { content: [{ type: 'text', text: 'Error: projectId is required.' }], isError: true };
  }

  const session = await getCurrentZones(projectId, base);
  if (!session) {
    return {
      content: [{ type: 'text', text: `No zone submission found for project "${projectId}". Ask the user to paint and submit zones in the dashboard first.` }],
      isError: true,
    };
  }

  return { content: [{ type: 'text', text: JSON.stringify(session, null, 2) }] };
}
