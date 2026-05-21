// mcp-tools/hayba-mcp/src/tools/asset-retriever/tag-snapshot.ts
//
// Dumps a flat { assetPath: tags[] } JSON file the UE plugin reads to
// enrich the Cognitive Map's per-cell tag list. Sorted keys for
// diff-friendliness; assets with zero tags are omitted to keep the file
// small.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface TagSnapshotHit {
  path: string;
  tags: string[];
}

export function writeTagSnapshot(outPath: string, hits: TagSnapshotHit[]): void {
  const map: Record<string, string[]> = {};
  for (const h of hits) {
    if (h.tags && h.tags.length > 0) map[h.path] = h.tags;
  }
  const sortedKeys = Object.keys(map).sort();
  const ordered: Record<string, string[]> = {};
  for (const k of sortedKeys) ordered[k] = map[k];
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(ordered, null, 2) + '\n', 'utf8');
}
