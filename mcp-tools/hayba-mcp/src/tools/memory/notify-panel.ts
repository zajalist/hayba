// Tell the editor's Memory panel that the store changed.
//
// The panel reads the store itself, so this is a nudge to re-read, not a
// payload — which is why it carries no arguments. Without it the Library tab
// shows whatever was there when it was last opened, and a memory written this
// turn simply is not in it until someone clicks Refresh. A panel that is
// quietly stale is worse than one that is obviously empty.
//
// Fire-and-forget on purpose: a memory write must not fail because an editor
// is not running, or be slowed by waiting for one.

import { executeCommand } from '../tool-executor.js';

let warned = false;

export function notifyMemoryPanel(): void {
  void executeCommand('ui_memory_set', {}).catch((e: unknown) => {
    // Worth saying once per process. Saying it on every write would turn
    // "no editor attached" into a wall of noise during normal headless use.
    if (!warned) {
      warned = true;
      console.warn(
        `[memory] could not refresh the editor Memory panel (${
          e instanceof Error ? e.message : String(e)
        }). Writes are still stored; the panel will catch up on its next Refresh.`,
      );
    }
  });
}

/** Test seam: lets a suite assert the once-only warning without a fresh process. */
export function resetMemoryPanelWarning(): void {
  warned = false;
}
