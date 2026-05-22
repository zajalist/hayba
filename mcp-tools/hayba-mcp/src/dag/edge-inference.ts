// mcp-tools/hayba-mcp/src/dag/edge-inference.ts
//
// Param-URI inference: any param value that is a valid artifact URI is
// treated as a read dependency. This draws DAG edges "for free" without
// the sliver author declaring every input. Already-declared reads are
// excluded so the caller can tag the remainder as `inferred`.

import { isUri } from './uri.js';

export function inferReadsFromParams(
  params: Record<string, unknown>,
  declared: string[] = [],
): string[] {
  const declaredSet = new Set(declared);
  const found = new Set<string>();
  for (const value of Object.values(params)) {
    if (typeof value === 'string' && isUri(value) && !declaredSet.has(value)) {
      found.add(value);
    }
  }
  return [...found];
}
