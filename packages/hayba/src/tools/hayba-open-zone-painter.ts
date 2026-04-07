import type { ToolResult } from './hayba-bake-terrain.js';
import { createProject, getProject, DEFAULT_PROJECTS_BASE } from '../projects.js';
import { unlockPainter } from '../zones.js';
import { config } from '../config.js';

export async function openZonePainterHandler(
  args: Record<string, unknown>,
  base = DEFAULT_PROJECTS_BASE,
): Promise<ToolResult> {
  const projectId = args.projectId as string | undefined;
  const projectName = (args.projectName as string | undefined) ?? 'Untitled Scene';
  const phase = (args.phase as 'a' | 'b' | undefined) ?? 'a';

  let resolvedId: string;

  if (projectId) {
    const existing = await getProject(projectId, base);
    if (!existing) {
      return { content: [{ type: 'text', text: `Error: project "${projectId}" not found.` }], isError: true };
    }
    resolvedId = projectId;
  } else {
    const project = await createProject(projectName, base);
    resolvedId = project.id;
  }

  unlockPainter(resolvedId, phase);

  const url = `http://${config.dashboardHost}:${config.dashboardPort}`;
  const result = {
    url,
    projectId: resolvedId,
    phase,
    message: `Open ${url} in your browser, navigate to Projects > select the project > Zone Painter. Switch to Phase ${phase.toUpperCase()} if needed.`,
  };

  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}
