import { z } from 'zod';
import type { ToolHandler } from '../hayba-bake-terrain.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { embedImage, SidecarUnavailableError } from './sidecar-client.js';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['external_search'],
  when: 'augmenting a moodboard with curated reference images keyed by topic',
  not_when: 'generating new images — use hayba_generate_moodboard',
};

export const schema = z.object({
  keywords: z.array(z.string()).min(1),
  top_k: z.number().int().min(1).max(20).optional(),
});

const REFERENCE_DIR = process.env.HAYBA_REFERENCE_DIR ?? path.resolve(process.cwd(), 'packages/hayba/addons/references');

function localReferences(keywords: string[], topK: number): string[] {
  const dir = process.env.HAYBA_REFERENCE_DIR ?? REFERENCE_DIR;
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(f => /\.(png|jpe?g|webp)$/i.test(f));
  const matches = files.filter(f => keywords.some(k => f.toLowerCase().includes(k.toLowerCase())));
  return matches.slice(0, topK).map(f => path.join(dir, f));
}

export const haybaFetchReferencesHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const topK = parsed.data.top_k ?? 5;
  const localPaths = localReferences(parsed.data.keywords, topK);

  const enriched = await Promise.all(localPaths.map(async (p) => {
    try {
      const buf = readFileSync(p);
      const base64 = buf.toString('base64');
      const { embedding } = await embedImage(base64);
      return { source: 'local', path: p, clip_embedding: embedding };
    } catch (e: unknown) {
      const msg = e instanceof SidecarUnavailableError
        ? `sidecar offline — embedding skipped (${e.message})`
        : (e instanceof Error ? e.message : String(e));
      return { source: 'local', path: p, clip_embedding: null, error: msg };
    }
  }));

  const dir = process.env.HAYBA_REFERENCE_DIR ?? REFERENCE_DIR;
  return {
    content: [{ type: 'text', text: JSON.stringify({
      keywords: parsed.data.keywords,
      references: enriched,
      note: enriched.length === 0 ? `No local matches in ${dir}. Set HAYBA_REFERENCE_DIR or wire HAYBA_UNSPLASH_KEY (unimplemented in v0.3).` : undefined,
    }, null, 2) }],
  };
};
