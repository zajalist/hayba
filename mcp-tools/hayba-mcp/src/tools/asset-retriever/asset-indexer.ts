import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { inferSource, type AssetDoc } from './types.js';
import { writeTagSnapshot } from './tag-snapshot.js';

function tagSnapshotPath(): string {
  return process.env.HAYBA_TAG_SNAPSHOT_PATH
    ?? join(homedir(), '.hayba', 'cache', 'retriever-tags.json');
}

export type Dispatch = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface BuildResult {
  docs: AssetDoc[];
  snapshotHash: string;
  fallbackUsed: boolean;
}

interface DescribeAssetsResponse {
  assets: Array<{ path: string; name?: string; class?: string; tags?: string[]; lastModified?: number }>;
}

interface ListPcgAssetsResponse {
  assets: Array<{ path: string } | string>;
}

export class AssetIndexer {
  private fallbackWarned = false;

  constructor(private dispatch: Dispatch) {}

  async build(opts: { forceRefresh?: boolean } = {}): Promise<BuildResult> {
    void opts.forceRefresh;
    let result: BuildResult;
    try {
      const r = await this.dispatch('describe_assets', { path: '/Game/' }) as DescribeAssetsResponse;
      const docs = r.assets.map(a => normalize(a));
      result = { docs, snapshotHash: hashDocs(docs), fallbackUsed: false };
    } catch (e) {
      if (/unknown_command/i.test((e as Error).message)) {
        if (!this.fallbackWarned) {
          console.warn('[asset-retriever] describe_assets unavailable; falling back to list_pcg_assets (path-only)');
          this.fallbackWarned = true;
        }
        const r = await this.dispatch('list_pcg_assets', { path: '/Game/' }) as ListPcgAssetsResponse;
        const docs = r.assets.map(a => {
          const path = typeof a === 'string' ? a : a.path;
          return normalize({ path });
        });
        result = { docs, snapshotHash: hashDocs(docs), fallbackUsed: true };
      } else {
        throw e;
      }
    }
    const snapshotHits = result.docs.map(d => ({ path: d.path, tags: d.tags ?? [] }));
    try {
      writeTagSnapshot(tagSnapshotPath(), snapshotHits);
    } catch (err) {
      console.error('[cogmap] failed to write tag snapshot:', err);
    }
    return result;
  }

  async describeDelta(paths: string[]): Promise<AssetDoc[]> {
    if (paths.length === 0) return [];
    const r = await this.dispatch('describe_assets', { paths }) as DescribeAssetsResponse;
    return r.assets.map(a => normalize(a));
  }
}

function normalize(a: { path: string; name?: string; class?: string; tags?: string[]; lastModified?: number }): AssetDoc {
  const path = a.path;
  return {
    path,
    name: a.name ?? path.split('/').pop() ?? path,
    class: a.class ?? 'Unknown',
    tags: a.tags ?? [],
    source: inferSource(path),
    lastModified: a.lastModified ?? 0,
  };
}

function hashDocs(docs: AssetDoc[]): string {
  const h = createHash('sha256');
  for (const d of [...docs].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(`${d.path}|${d.lastModified}\n`);
  }
  return h.digest('hex');
}
