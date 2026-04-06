import type { ToolHandler } from './hayba-bake-terrain.js';
import { launchGaea, detectGaeaPath } from '../gaea/gaea-launcher.js';

export const openInGaeaTool: ToolHandler = async (args, session) => {
  const terrainPath = (args.path as string | undefined) ?? session.terrainPath;
  if (!terrainPath) {
    return { content: [{ type: 'text', text: 'Error: no terrain path provided and no terrain currently loaded.' }], isError: true };
  }

  const gaeaExePath = session.gaeaExePath || detectGaeaPath();
  if (!gaeaExePath) {
    return { content: [{ type: 'text', text: 'Error: Gaea.exe not found. Set gaeaExePath in swarmhost.config.json.' }], isError: true };
  }

  try {
    const pid = launchGaea(gaeaExePath, terrainPath);
    return {
      content: [{
        type: 'text',
        text: [
          `Gaea launched successfully.`,
          `File: ${terrainPath}`,
          `PID: ${pid}`,
          ``,
          `Note: Gaea does not auto-reload open files. If this file was already open, close and reopen it.`,
        ].join('\n')
      }]
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Failed to open in Gaea: ${message}` }], isError: true };
  }
};
