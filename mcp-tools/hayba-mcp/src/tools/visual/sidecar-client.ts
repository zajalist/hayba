const DEFAULT_URL = 'http://localhost:7821';

function sidecarUrl(): string {
  return process.env.HAYBA_SIDECAR_URL ?? DEFAULT_URL;
}

export async function embedImage(imageBase64: string, opts?: { spatial?: boolean; detect?: boolean }): Promise<{ embedding: number[]; dim: number }> {
  const res = await fetch(`${sidecarUrl()}/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image_base64: imageBase64, spatial: opts?.spatial ?? false, detect: opts?.detect ?? false }),
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
