import type { ToolResult } from './types.js';
import { getCurrentZones, getScratchZones } from '../zones.js';
import { DEFAULT_PROJECTS_BASE } from '../projects.js';

export async function readZonesHandler(
  args: Record<string, unknown>,
  base = DEFAULT_PROJECTS_BASE,
): Promise<ToolResult> {
  const projectId = args.projectId as string | undefined;
  const scratchSessionId = args.scratchSessionId as string | undefined;

  if (!projectId && !scratchSessionId) {
    return { content: [{ type: 'text', text: 'Error: projectId or scratchSessionId is required.' }], isError: true };
  }

  const session = scratchSessionId
    ? await getScratchZones(scratchSessionId, base)
    : await getCurrentZones(projectId!, base);

  if (!session) {
    const target = scratchSessionId ? `scratch session "${scratchSessionId}"` : `project "${projectId}"`;
    return {
      content: [{ type: 'text', text: `No zone submission found for ${target}. Ask the user to paint and submit zones first.` }],
      isError: true,
    };
  }

  return { content: [{ type: 'text', text: JSON.stringify(session, null, 2) }] };
}
