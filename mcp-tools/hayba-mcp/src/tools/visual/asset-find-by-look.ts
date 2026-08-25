// asset_find_by_look — find assets that LOOK like what was asked for.
//
// asset_search matches words against names and descriptions, so it finds a
// mossy boulder only if somebody typed "moss" into the name. This asks the
// question the user actually has, using the CLIP model the sidecar already
// runs, and returns the two answers separately: what it ranked, and what it
// could not look at.

import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { executeCommand } from '../tool-executor.js';
import { rankAssetsByIntent, type AssetCandidate } from './asset-intent-match.js';

export const meta: HaybaToolMeta = {
  cost: 'high',
  effects: [],
  when: 'you want the asset that looks like a description, and its name may not say so',
  not_when: 'you already know the name or path — asset_search is far cheaper',
};

/** asset_search stops emitting thumbnails after 50 (HaybaMCPAssetHandler.cpp).
 *  Asking for more would silently rank a subset. */
export const THUMBNAIL_CAP = 50;

export const schema = z.object({
  intent: z.string().min(1).describe('What you are looking for, in words — e.g. "a mossy granite boulder"'),
  path: z.string().optional().describe('Content path to search under (default /Game)'),
  class_filter: z.string().optional().describe('Exact class name filter, e.g. StaticMesh'),
  name_filter: z.string().optional().describe('Narrow the candidate set by name before looking at any of them'),
  limit: z.number().int().positive().max(THUMBNAIL_CAP).optional()
    .describe(`How many candidates to look at (max ${THUMBNAIL_CAP}, the thumbnail cap)`),
});

export type AssetFindByLookParams = z.infer<typeof schema>;

export interface AssetFindByLookResult {
  ok: boolean;
  intent: string;
  ranked: Array<{ path: string; name: string; score: number }>;
  unscored: Array<{ path: string; reason: string }>;
  candidates_considered: number;
  /** Set when the candidate set was cut short. A silent truncation reads as
   *  "these are all the assets", which is a different and untrue statement. */
  truncated?: { returned: number; cap: number; note: string };
  unavailable?: string;
}

export async function assetFindByLook(
  params: AssetFindByLookParams,
): Promise<AssetFindByLookResult> {
  const limit = params.limit ?? THUMBNAIL_CAP;

  const search = await executeCommand<Record<string, unknown>>('asset_search', {
    path: params.path ?? '/Game',
    ...(params.class_filter ? { class_filter: params.class_filter } : {}),
    ...(params.name_filter ? { name_filter: params.name_filter } : {}),
    include_thumbnails: true,
    thumbnail_size: 128,
  });

  const found = (search?.assets as Array<Record<string, unknown>> | undefined) ?? [];
  const candidates: AssetCandidate[] = found.slice(0, limit).map((a) => ({
    path: String(a.path ?? ''),
    name: String(a.name ?? ''),
    thumbnail_b64: typeof a.thumbnail_b64 === 'string' ? a.thumbnail_b64 : undefined,
  }));

  const result = await rankAssetsByIntent(params.intent, candidates);

  const out: AssetFindByLookResult = {
    ok: !result.unavailable,
    intent: params.intent,
    ranked: result.ranked,
    unscored: result.unscored,
    candidates_considered: candidates.length,
  };
  if (result.unavailable) out.unavailable = result.unavailable;
  if (found.length > candidates.length) {
    out.truncated = {
      returned: found.length,
      cap: limit,
      note: `${found.length} assets matched the filters; only the first ${candidates.length} were looked at. Narrow with name_filter or class_filter to rank the rest.`,
    };
  }
  return out;
}

export const assetFindByLookHandler: ToolHandler = async (args) => {
  const params = schema.parse(args);
  const result = await assetFindByLook(params);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    isError: !result.ok,
  };
};
