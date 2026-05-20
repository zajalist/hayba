import type { EmbeddingBackend } from './tool-index.js';

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.HAYBA_EMBED_MODEL_OLLAMA ?? 'nomic-embed-text';
const XENOVA_MODEL = process.env.HAYBA_EMBED_MODEL_XENOVA ?? 'Xenova/all-MiniLM-L6-v2';

export async function probeOllama(): Promise<EmbeddingBackend | null> {
  try {
    const probe = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt: 'probe' }),
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

export async function probeTransformers(): Promise<EmbeddingBackend | null> {
  try {
    // @huggingface/transformers exposes `pipeline` for feature-extraction.
    // The mean-pooled, normalized embedding is in `result.data` as a Float32Array.
    const mod = await import('@huggingface/transformers');
    const pipe = await mod.pipeline('feature-extraction', XENOVA_MODEL);
    return {
      id: `transformers:${XENOVA_MODEL}`,
      async embed(texts: string[]): Promise<Float32Array[]> {
        const out: Float32Array[] = [];
        for (const t of texts) {
          const result = await (pipe as any)(t, { pooling: 'mean', normalize: true });
          out.push(new Float32Array(result.data as Float32Array));
        }
        return out;
      },
    };
  } catch {
    return null;
  }
}

export async function selectEmbeddingBackend(): Promise<EmbeddingBackend | null> {
  return (await probeOllama()) ?? (await probeTransformers());
}
