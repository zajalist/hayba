// mcp-tools/hayba-mcp/src/dag/uri.ts
//
// Artifact URIs identify every node in the dependency DAG. Format is
// "<namespace>://<rest>" with a fixed namespace set. The `rest` must be
// non-empty.

export const DAG_NAMESPACES = new Set(['ue', 'planet', 'file', 'sliver'] as const);

export type ParseUriResult =
  | { ok: true; namespace: string; rest: string }
  | { ok: false };

export function parseUri(s: string): ParseUriResult {
  const idx = s.indexOf('://');
  if (idx <= 0) return { ok: false };
  const namespace = s.slice(0, idx);
  const rest = s.slice(idx + 3);
  if (!DAG_NAMESPACES.has(namespace as never)) return { ok: false };
  if (rest.length === 0) return { ok: false };
  return { ok: true, namespace, rest };
}

export function isUri(s: string): boolean {
  return parseUri(s).ok;
}
