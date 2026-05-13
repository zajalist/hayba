import { z } from 'zod';
import type { ToolHandler } from '../hayba-bake-terrain.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { embedImage, SidecarUnavailableError } from './sidecar-client.js';

export const meta: HaybaToolMeta = {
  cost: 'high',
  effects: ['external_image_gen', 'gpu_load'],
  when: 'starting a new scene — fetch generated moodboard images and embeddings to ground later asset choices',
  not_when: 'iterating on an already-grounded scene — use hayba_fetch_references for cheaper retrieval',
};

export const schema = z.object({
  prompt: z.string().min(1),
  count: z.number().int().min(1).max(8).optional(),
  style: z.string().optional(),
});

export const haybaGenerateMoodboardHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }

  const url = process.env.HAYBA_IMAGEGEN_URL;
  if (!url) {
    return {
      content: [{ type: 'text', text: 'Image generation endpoint not configured (set HAYBA_IMAGEGEN_URL). Returning empty moodboard.' }],
      isError: true,
    };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: parsed.data.prompt, count: parsed.data.count ?? 4, style: parsed.data.style }),
    });
    if (!res.ok) {
      return { content: [{ type: 'text', text: `image gen ${res.status}: ${await res.text()}` }], isError: true };
    }
    const payload = (await res.json()) as { images: Array<{ url?: string; base64?: string }> };

    const enriched = await Promise.all((payload.images ?? []).map(async (img) => {
      if (!img.base64) return { ...img, clip_embedding: null };
      try {
        const { embedding } = await embedImage(img.base64);
        return { ...img, clip_embedding: embedding };
      } catch (e) {
        const msg = e instanceof SidecarUnavailableError
          ? `sidecar offline — embedding skipped (${e.message})`
          : (e as Error).message;
        return { ...img, clip_embedding: null, embedding_error: msg };
      }
    }));

    return { content: [{ type: 'text', text: JSON.stringify({ prompt: parsed.data.prompt, images: enriched }, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `hayba_generate_moodboard error: ${(e as Error).message}` }], isError: true };
  }
};
