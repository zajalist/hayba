import { inferSource, type AssetDoc } from './types.js';
import type { Dispatch } from './asset-indexer.js';

export type VerifyResult =
  | { exists: true; doc: AssetDoc }
  | { exists: false; reason: 'not_in_registry' | 'path_mismatch' | 'registry_unavailable'; attempted: string };

interface DescribeAssetsResponse {
  assets: Array<{ path: string; name?: string; class?: string; tags?: string[]; lastModified?: number }>;
}

export class AssetVerifier {
  constructor(private dispatch: Dispatch) {}

  async verifyPath(expectedPath: string): Promise<VerifyResult> {
    try {
      const r = await this.dispatch('describe_assets', { paths: [expectedPath] }) as DescribeAssetsResponse;
      if (!r.assets || r.assets.length === 0) {
        return { exists: false, reason: 'not_in_registry', attempted: expectedPath };
      }
      const a = r.assets[0];
      if (a.path !== expectedPath) {
        return { exists: false, reason: 'path_mismatch', attempted: expectedPath };
      }
      return {
        exists: true,
        doc: {
          path: a.path,
          name: a.name ?? a.path.split('/').pop() ?? a.path,
          class: a.class ?? 'Unknown',
          tags: a.tags ?? [],
          source: inferSource(a.path),
          lastModified: a.lastModified ?? 0,
        },
      };
    } catch {
      return { exists: false, reason: 'registry_unavailable', attempted: expectedPath };
    }
  }
}
