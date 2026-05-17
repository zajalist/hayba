const DEFAULT_URL = 'http://localhost:7821';
const DEFAULT_HEALTH_TIMEOUT_MS = 1500;
const DEFAULT_EMBED_TIMEOUT_MS = 30000;

function sidecarUrl(): string {
  return process.env.HAYBA_SIDECAR_URL ?? DEFAULT_URL;
}

export interface SidecarHealth {
  available: boolean;
  url: string;
  models: Record<string, boolean>;
  active_models: string[];
  error?: string;
  checked_at: number;
}

let cached: SidecarHealth | null = null;

async function fetchWithTimeout(url: string, init: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS);
  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function pingSidecar(timeoutMs: number = DEFAULT_HEALTH_TIMEOUT_MS): Promise<SidecarHealth> {
  const url = sidecarUrl();
  const checkedAt = Date.now();
  try {
    const res = await fetchWithTimeout(`${url}/health`, { method: 'GET', timeoutMs });
    if (!res.ok) {
      const health: SidecarHealth = {
        available: false,
        url,
        models: {},
        active_models: [],
        error: `sidecar /health returned ${res.status}`,
        checked_at: checkedAt,
      };
      cached = health;
      return health;
    }
    const body = (await res.json()) as { ok?: boolean; models?: Record<string, boolean> };
    const models = body.models ?? {};
    const activeModels = Object.entries(models)
      .filter(([, enabled]) => Boolean(enabled))
      .map(([name]) => name);
    const health: SidecarHealth = {
      available: body.ok !== false && activeModels.length > 0,
      url,
      models,
      active_models: activeModels,
      checked_at: checkedAt,
    };
    cached = health;
    return health;
  } catch (e: unknown) {
    const health: SidecarHealth = {
      available: false,
      url,
      models: {},
      active_models: [],
      error: e instanceof Error ? e.message : String(e),
      checked_at: checkedAt,
    };
    cached = health;
    return health;
  }
}

export function getCachedSidecarHealth(): SidecarHealth | null {
  return cached;
}

export function setCachedSidecarHealth(h: SidecarHealth | null): void {
  cached = h;
}

export class SidecarUnavailableError extends Error {
  constructor(public health: SidecarHealth) {
    super(`visual sidecar unavailable at ${health.url}${health.error ? ` (${health.error})` : ''}`);
    this.name = 'SidecarUnavailableError';
  }
}

/**
 * If we have a cached health probe and it reports unavailable, refuse to issue
 * the request — avoids long connect-timeouts in degraded mode. If no cache
 * exists, the call proceeds and the cache is populated by next ping.
 */
function assertSidecarAvailable(): void {
  if (cached && !cached.available) {
    throw new SidecarUnavailableError(cached);
  }
}

export async function embedImage(imageBase64: string, opts?: { spatial?: boolean; detect?: boolean; timeoutMs?: number }): Promise<{ embedding: number[]; dim: number }> {
  assertSidecarAvailable();
  const res = await fetchWithTimeout(`${sidecarUrl()}/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image_base64: imageBase64, spatial: opts?.spatial ?? false, detect: opts?.detect ?? false }),
    timeoutMs: opts?.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS,
  });
  if (!res.ok) {
    throw new Error(`sidecar /embed ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<{ embedding: number[]; dim: number }>;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
