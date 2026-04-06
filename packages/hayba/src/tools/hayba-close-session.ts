import type { ToolHandler } from './hayba-bake-terrain.js';
import { stopWatching } from '../gaea/file-watcher.js';
import { isProcessRunning } from '../gaea/gaea-launcher.js';

export const closeSessionHandler: ToolHandler = async (_args, session) => {
  stopWatching();
  if (session.gaeaPid && isProcessRunning(session.gaeaPid)) {
    try { process.kill(session.gaeaPid); } catch { /* ignore */ }
  }
  session.clearGaeaSession();
  return { content: [{ type: 'text', text: 'Session closed. Gaea stopped.' }] };
};
