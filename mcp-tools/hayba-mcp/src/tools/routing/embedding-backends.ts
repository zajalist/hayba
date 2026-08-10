import type { EmbeddingBackend } from './tool-index.js';

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.HAYBA_EMBED_MODEL_OLLAMA ?? 'nomic-embed-text';

/** How long the startup probe waits for Ollama. A refused connection fails fast,
 *  but a firewalled or black-holed port hangs until the OS gives up — which
 *  stalls server startup behind a backend we were only ever guessing at. */
const PROBE_TIMEOUT_MS = Number(process.env.HAYBA_EMBED_PROBE_TIMEOUT_MS ?? 2000);

export async function probeOllama(): Promise<EmbeddingBackend | null> {
  try {
    const probe = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt: 'probe' }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!probe.ok) return null;
    return {
      id: `ollama:${OLLAMA_MODEL}`,
      async embed(texts: string[]): Promise<Float32Array[]> {
        const out: Float32Array[] = [];
        for (const t of texts) {
          const r = await fetch(`${OLLAMA_URL}/api/embeddings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: OLLAMA_MODEL, prompt: t }),
          });
          if (!r.ok) throw new Error(`ollama embed http ${r.status}`);
          const json = (await r.json()) as { embedding: number[] };
          out.push(new Float32Array(json.embedding));
        }
        return out;
      },
    };
  } catch {
    return null;
  }
}

export async function selectEmbeddingBackend(): Promise<EmbeddingBackend | null> {
  // Ollama is optional. A refused, offline, or timed-out probe selects the
  // deterministic lexical path; backend discovery never downloads a model or
  // prevents the non-embedding MCP surface from starting.
  return probeOllama();
}
