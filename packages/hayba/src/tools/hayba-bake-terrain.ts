import type { SessionManager } from '../gaea/session.js';

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
export type ToolHandler = (args: Record<string, unknown>, session: SessionManager) => Promise<ToolResult>;

export const bakeTerrain: ToolHandler = async (args, session) => {
  const terrainPath = (args.path as string | undefined) ?? session.terrainPath;
  if (!terrainPath) {
    return {
      content: [{ type: 'text', text: 'Error: path is required — no terrain is currently loaded.' }],
      isError: true,
    };
  }

  const variables = args.variables as Record<string, unknown> | undefined;
  const ignorecache = args.ignorecache !== false;

  if (terrainPath !== session.terrainPath) {
    await session.enqueue(() => session.client.loadGraph(terrainPath));
    session.setTerrainPath(terrainPath);
  }

  try {
    await session.enqueue(() => session.client.cook(undefined, variables, ignorecache));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Bake failed: ${message}` }], isError: true };
  }

  let exported: { heightmap: string; normalmap?: string; splatmap?: string } | null = null;
  try {
    exported = await session.enqueue(() => session.client.export(session.outputDir, 'EXR'));
  } catch {
    // Cook succeeded but export scan failed — not fatal
  }

  const lines = [
    `Terrain baked successfully.`,
    `File: ${terrainPath}`,
    variables ? `Variables: ${JSON.stringify(variables)}` : null,
    ``,
    exported ? `Output files:` : `Note: Bake completed but output files not yet located.`,
    exported?.heightmap ? `  Heightmap: ${exported.heightmap}` : null,
    exported?.normalmap ? `  Normal map: ${exported.normalmap}` : null,
    exported?.splatmap  ? `  Splatmap: ${exported.splatmap}` : null,
  ].filter(Boolean).join('\n');

  return { content: [{ type: 'text', text: lines }] };
};
