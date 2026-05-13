import { z } from 'zod';
import { ensureConnected } from '../../tcp-client.js';
import type { ToolHandler } from '../types.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: [],
  when: 'finding largest textures by memory or surfacing compression-format outliers',
  not_when: 'auditing meshes — use mesh_audit',
};

export const schema = z.object({
  top_n: z.number().int().min(1).max(200).optional().describe('Top entries to return. Default 25.'),
  min_kb: z.number().int().min(0).optional().describe('Minimum on-disk size (KB) to include.'),
  path_prefix: z.string().optional().describe('Only audit assets whose path starts with this prefix (e.g. /Game/).'),
});

export const textureAuditHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  try {
    const client = await ensureConnected();
    const resp = await client.send('texture_audit', parsed.data as Record<string, unknown>, 30_000);
    if (!resp.ok) {
      return { content: [{ type: 'text', text: `texture_audit failed: ${resp.error ?? 'unknown'}` }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(resp.data, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `texture_audit error: ${(e as Error).message}` }], isError: true };
  }
};
