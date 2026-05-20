import { ensureConnected } from '../tcp-client.js';
import { getCachedSidecarHealth, pingSidecar } from './visual/sidecar-client.js';

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
    return { connected: false, error: response.error, ...sidecarFields };
  } catch (err) {
    return {
      connected: false,
      error: err instanceof Error ? err.message : 'Unknown error',
      ...sidecarFields,
    };
  }
}
