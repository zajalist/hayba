import type { AssetDoc, AssetSource } from './types.js';

export interface Filter {
  path?: string;
  class?: string;
  tag?: string;
  source?: AssetSource;
}

export interface Page {
  total: number;
  offset: number;
  limit: number;
  docs: AssetDoc[];
}

const MAX_LIMIT = 200;

export class AssetCatalog {
  constructor(private docs: AssetDoc[]) {}

  list(filter: Filter, offset = 0, limit = 50): Page {
    const cappedLimit = Math.min(Math.max(limit, 1), MAX_LIMIT);
    const filtered = this.docs.filter(d => match(d, filter));
    const slice = filtered.slice(offset, offset + cappedLimit);
    return { total: filtered.length, offset, limit: cappedLimit, docs: slice };
  }
}

function match(d: AssetDoc, f: Filter): boolean {
  if (f.path && !d.path.startsWith(f.path)) return false;
  if (f.class && d.class !== f.class) return false;
  if (f.source && d.source !== f.source) return false;
  if (f.tag && !d.tags.includes(f.tag)) return false;
  return true;
}
