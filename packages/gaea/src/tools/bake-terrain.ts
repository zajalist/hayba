import { registerTool, type ToolHandler } from "./index.js";

export const bakeTerrain: ToolHandler = async (args, session) => {
  const terrainPath = (args.path as string | undefined) ?? session.terrainPath;
  if (!terrainPath) {
    return {
      content: [{ type: "text", text: "Error: path is required — no terrain is currently loaded." }],
      isError: true,
    };
  }

  const variables = args.variables as Record<string, unknown> | undefined;
  const ignorecache = args.ignorecache !== false; // default true

  // Load the terrain if it isn't already the active one
  if (terrainPath !== session.terrainPath) {
    await session.enqueue(() => session.client.loadGraph(terrainPath));
    session.setTerrainPath(terrainPath);
  }

  try {
    await session.enqueue(() => session.client.cook(undefined, variables, ignorecache));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Bake failed: ${message}` }], isError: true };
  }

  let exported: { heightmap: string; normalmap?: string; splatmap?: string } | null = null;
  try {
    exported = await session.enqueue(() => session.client.export(session.outputDir, "EXR"));
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
  ].filter(Boolean).join("\n");

  return { content: [{ type: "text", text: lines }] };
};

registerTool(
  {
    name: "bake_terrain",
    description:
      `Bake a Gaea terrain file using Gaea.Swarm.exe. Optionally inject variable overrides via -v flags without modifying the file.

Use read_terrain_variables first to see what variables are available in the file.
Variables are passed as CLI flags only and do not persist to the .terrain file.

Examples:
- bake_terrain({ path: "/path/to/file.terrain" })
- bake_terrain({ path: "/path/to/file.terrain", variables: { Seed: 42, Scale: 2.0 } })`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the .terrain file to bake" },
        variables: {
          type: "object",
          description: "Variable overrides to inject as -v key=value CLI flags. Keys must match variable names declared in the terrain file."
        },
        ignorecache: {
          type: "boolean",
          description: "Whether to ignore baked cache and force a full re-bake (default: true)"
        }
      }
    }
  },
  bakeTerrain
);
