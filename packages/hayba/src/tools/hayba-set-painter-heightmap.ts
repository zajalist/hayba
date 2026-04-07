import type { ToolResult } from './hayba-bake-terrain.js';
import { setHeightmap } from '../zones.js';
import { DEFAULT_PROJECTS_BASE } from '../projects.js';

export async function setPainterHeightmapHandler(
  args: Record<string, unknown>,
  base = DEFAULT_PROJECTS_BASE,
): Promise<ToolResult> {
  const projectId = args.projectId as string | undefined;
  const heightmapPath = args.heightmapPath as string | undefined;

  if (!projectId) return { content: [{ type: 'text', text: 'Error: projectId is required.' }], isError: true };
  if (!heightmapPath) return { content: [{ type: 'text', text: 'Error: heightmapPath is required.' }], isError: true };

  await setHeightmap(projectId, heightmapPath, base);
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, projectId, heightmapPath }) }] };
}
