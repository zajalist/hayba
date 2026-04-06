import { registerTool, type ToolHandler } from "./index.js";
import { launchGaea, detectGaeaPath } from "../gaea-launcher.js";

export const openInGaeaTool: ToolHandler = async (args, session) => {
  const terrainPath = (args.path as string | undefined) ?? session.terrainPath;
  if (!terrainPath) {
    return {
      content: [{ type: "text", text: "Error: no terrain path provided and no terrain currently loaded." }],
      isError: true,
    };
  }

  const gaeaExePath = session.gaeaExePath || detectGaeaPath();
  if (!gaeaExePath) {
    return {
      content: [{ type: "text", text: "Error: Gaea.exe not found. Set gaeaExePath in swarmhost.config.json." }],
      isError: true,
    };
  }

  try {
    const pid = launchGaea(gaeaExePath, terrainPath);
    return {
      content: [{
        type: "text",
        text: [
          `Gaea launched successfully.`,
          `File: ${terrainPath}`,
          `PID: ${pid}`,
          ``,
          `Note: Gaea does not auto-reload open files. If this file was already open, close and reopen it to see the latest changes.`,
        ].join("\n")
      }]
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Failed to open in Gaea: ${message}` }], isError: true };
  }
};

registerTool(
  {
    name: "open_in_gaea",
    description:
      `Open a .terrain file in the Gaea editor. Call this after writing changes to a terrain file so the user can see the updated graph.

Gaea does not auto-reload files that are already open — the user will need to close and reopen the file if it was already loaded.
This tool launches Gaea.exe with the terrain file as an argument.`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the .terrain file (uses currently loaded terrain if omitted)" }
      }
    }
  },
  openInGaeaTool
);
