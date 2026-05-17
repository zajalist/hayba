import { z } from 'zod';
import type { ToolHandler } from '../hayba-bake-terrain.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { embedImage, cosineSimilarity } from './sidecar-client.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['gpu_load'],
  when: 'measuring how visually similar a captured viewport is to a reference image',
  not_when: 'comparing semantic content — CLIP scores capture style and composition more than precise geometry',
};

export const schema = z.object({
  image_a_base64: z.string().min(1),
  image_b_base64: z.string().min(1),
});

export const haybaCompareClipScoreHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  try {
    const [a, b] = await Promise.all([
      embedImage(parsed.data.image_a_base64),
      embedImage(parsed.data.image_b_base64),
    ]);
    const score = cosineSimilarity(a.embedding, b.embedding);
    return { content: [{ type: 'text', text: JSON.stringify({ cosine_similarity: score, dim: a.dim }, null, 2) }] };
  } catch (e: unknown) {
    return { content: [{ type: 'text', text: `hayba_compare_clip_score error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
};
