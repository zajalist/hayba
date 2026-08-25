// Rank assets against what the user actually asked for, by looking at them.
//
// Asset selection has been text-only: match the words in a request against
// asset names and descriptions. That works exactly as well as the names do,
// which is why "mossy boulder" finds SM_Rock_04 only if somebody typed "moss"
// into its name. A CLIP model has been loaded beside this the whole time.
//
// The comparison is a dot product of two normalised vectors -- one for the
// phrase, one for each thumbnail -- so this module is small and the judgement
// it makes is easy to state: how much does this thing LOOK like what was
// asked for.

import { embedImage, embedText, cosineSimilarity } from './sidecar-client.js';

export interface AssetCandidate {
  path: string;
  name: string;
  /** Base64 PNG from asset_search's include_thumbnails. */
  thumbnail_b64?: string;
}

export interface RankedAsset {
  path: string;
  name: string;
  /** Cosine similarity in [-1, 1]. Higher is a closer visual match. */
  score: number;
}

export interface RankResult {
  ranked: RankedAsset[];
  /** Candidates that could not be looked at, and why. Never scored 0 and mixed
   *  into the ranking -- a zero would read as "judged, and a poor match". */
  unscored: Array<{ path: string; reason: string }>;
  /** Set when nothing could be ranked at all. The caller falls back to text
   *  search and should say that it did. */
  unavailable?: string;
}

export interface RankDeps {
  embedText: typeof embedText;
  embedImage: typeof embedImage;
}

const DEFAULT_DEPS: RankDeps = { embedText, embedImage };

/**
 * Score each candidate by how much its thumbnail looks like `intent`.
 *
 * Thumbnails are embedded one at a time because that is what /embed accepts;
 * the text side is one call for the whole run. Failures are per-candidate: one
 * unreadable thumbnail must not lose the other thirty-nine results.
 */
export async function rankAssetsByIntent(
  intent: string,
  candidates: readonly AssetCandidate[],
  deps: RankDeps = DEFAULT_DEPS,
): Promise<RankResult> {
  const unscored: Array<{ path: string; reason: string }> = [];
  if (candidates.length === 0) return { ranked: [], unscored };

  let intentVec: number[];
  try {
    const t = await deps.embedText([intent]);
    const v = t.embeddings[0];
    if (!v || v.length === 0) {
      return { ranked: [], unscored, unavailable: 'the intent produced no embedding' };
    }
    intentVec = v;
  } catch (e) {
    // Without the text side there is nothing to compare against, so this is
    // fatal for the whole run rather than per-candidate.
    return {
      ranked: [],
      unscored,
      unavailable: `could not embed the intent: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const ranked: RankedAsset[] = [];
  for (const c of candidates) {
    if (!c.thumbnail_b64) {
      unscored.push({ path: c.path, reason: 'no thumbnail — nothing to look at' });
      continue;
    }
    try {
      const img = await deps.embedImage(c.thumbnail_b64);
      ranked.push({
        path: c.path,
        name: c.name,
        score: Number(cosineSimilarity(intentVec, img.embedding).toFixed(4)),
      });
    } catch (e) {
      unscored.push({ path: c.path, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return { ranked, unscored };
}
