import { registerTool, type ToolHandler } from "./index.js";
import { stopWatching } from "../file-watcher.js";
import { isProcessRunning } from "../gaea-launcher.js";

export const closeSessionHandler: ToolHandler = async (_args, session) => {
  stopWatching();

  if (session.gaeaPid && isProcessRunning(session.gaeaPid)) {
    try { process.kill(session.gaeaPid); } catch { /* ignore */ }
  }

  session.clearGaeaSession();

  return { content: [{ type: "text", text: "Session closed. Gaea stopped." }] };
};

registerTool(
  {
    name: "close_session",
    description: "Close the current live session and stop Gaea. Clears saved session state.",
    inputSchema: { type: "object", properties: {} }
  },
  closeSessionHandler
);
