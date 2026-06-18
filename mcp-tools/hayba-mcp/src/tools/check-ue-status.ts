import { execFile } from 'node:child_process';
import { ensureConnected } from '../tcp-client.js';
import { getCachedSidecarHealth, pingSidecar } from './visual/sidecar-client.js';

/**
 * Best-effort check for a running UnrealEditor process, so a failed TCP connect
 * can distinguish "editor not running" from "editor up but plugin listener
 * closed" (plugin failed to load / still booting / shutting down). Cross-platform,
 * short timeout, never throws — resolves null when detection itself fails.
 */
function detectEditorProcess(): Promise<boolean | null> {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'tasklist' : 'pgrep';
  const args = isWin
    ? ['/FI', 'IMAGENAME eq UnrealEditor.exe', '/NH']
    : ['-f', 'UnrealEditor'];
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 2000, windowsHide: true }, (err, stdout) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return resolve(null);
        const out = (stdout || '').toLowerCase();
        resolve(isWin ? out.includes('unrealeditor.exe') : out.trim().length > 0);
      });
    } catch {
      resolve(null);
    }
  });
}

function diagnoseDisconnect(editorRunning: boolean | null): string | undefined {
  if (editorRunning === true) {
    return 'UnrealEditor process is running but the plugin TCP port is closed — the HaybaMCPToolkit plugin likely failed to load (check the editor log for a module load error / missing dependency), is still booting, or is shutting down.';
  }
  if (editorRunning === false) {
    return 'No UnrealEditor process found — launch the editor with the HaybaMCPToolkit plugin enabled.';
  }
  return undefined;
}

export interface UeStatus {
  connected: boolean;
  error?: string;
  visual_embeddings_available: boolean;
  active_models: string[];
  sidecar_url?: string;
  sidecar_error?: string;
  [key: string]: unknown;
}

export interface CheckUeStatusOpts {
  /** Fired exactly once, the first time a poll succeeds in this process. */
  onConnected?: () => void | Promise<void>;
}

let connectedLatch = false;

/** Test-only: reset the once-only connected latch. */
export function __resetConnectedLatch(): void { connectedLatch = false; }

export async function checkUeStatus(opts: CheckUeStatusOpts = {}): Promise<UeStatus> {
  // Sidecar — prefer cached snapshot (filled at startup); refresh on demand if
  // we've never probed. Don't block UE status on sidecar latency.
  let sidecar = getCachedSidecarHealth();
  if (!sidecar) {
    sidecar = await pingSidecar();
  }

  const sidecarFields = {
    visual_embeddings_available: sidecar.available,
    active_models: sidecar.active_models,
    sidecar_url: sidecar.url,
    sidecar_error: sidecar.error,
  };

  try {
    const client = await ensureConnected();
    const response = await client.send('ping', {}, 5000);
    if (response.ok && response.data) {
      if (!connectedLatch) {
        connectedLatch = true;
        try { await opts.onConnected?.(); } catch { /* ignore callback errors */ }
      }
      return { connected: true, ...sidecarFields, ...(response.data as Record<string, unknown>) };
    }
    const editorRunning = await detectEditorProcess();
    return {
      connected: false,
      error: response.error,
      editor_process_detected: editorRunning ?? undefined,
      diagnostic: diagnoseDisconnect(editorRunning),
      ...sidecarFields,
    };
  } catch (err) {
    const editorRunning = await detectEditorProcess();
    return {
      connected: false,
      error: err instanceof Error ? err.message : 'Unknown error',
      editor_process_detected: editorRunning ?? undefined,
      diagnostic: diagnoseDisconnect(editorRunning),
      ...sidecarFields,
    };
  }
}
