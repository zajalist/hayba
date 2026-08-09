// Historical/expected parameter-name aliasing — the ONE place this
// normalisation happens. See docs/adr/0007 ("a static check must know every
// form of the call it guards") and, more directly, the failure it is fixing:
// GitHub issue #339 — two independent sessions cold-called tools with the
// "obvious" sibling spelling of a param (widget_blueprint_path instead of
// ui_query's `path`, asset_paths instead of asset_delete's `paths`, ...),
// burned a full round-trip on a validation error, then had to re-read the
// signature and retry.
//
// This module does exactly one thing: given an args object and a
// canonical-name -> historical-alternates map, produce a normalised args
// object with every alternate folded onto its canonical key. It does NOT
// validate types or requiredness — that stays the job of the tool's own zod
// schema, which is parsed against the NORMALISED object, unchanged. Nothing
// here widens what a tool's documented signature says: get_tool_signature and
// the schema registry keep reading the original canonical schema, never this
// module's output shape.
//
// Every call site (ueTool, the PyToolDescriptor factory, hayba_invoke, and the
// two hand-registered meta-tools) routes through resolveAliases so the rule
// cannot drift between dispatch paths — the exact failure mode ADR 0007
// documents for a guard taught only one form of a call.

/** Canonical param name -> the historical/expected spellings that should also
 *  be accepted for it. */
export type AliasMap = Record<string, readonly string[]>;

export type AliasResolution =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Fold alternate-spelling keys onto their canonical key.
 *
 * - Only the canonical key present: untouched.
 * - Only an alternate present: its value is copied onto the canonical key and
 *   the alternate key is removed.
 * - BOTH the canonical key and an alternate (or two alternates for the same
 *   canonical) present with equal values: the duplicate is silently dropped.
 * - Present with DIFFERENT values: this is a caller error — fail loudly with
 *   a message naming both spellings, rather than silently preferring one.
 *
 * The input object is not mutated; a shallow copy is returned.
 */
export function resolveAliases(
  args: Record<string, unknown>,
  aliases: AliasMap,
): AliasResolution {
  const out: Record<string, unknown> = { ...args };
  for (const [canonical, alternates] of Object.entries(aliases)) {
    for (const alt of alternates) {
      if (!(alt in out)) continue;
      const altValue = out[alt];
      delete out[alt];
      if (canonical in out) {
        if (!deepEqual(out[canonical], altValue)) {
          return {
            ok: false,
            error:
              `Conflicting values for "${canonical}": also supplied as "${alt}" with a different value. Pass only one.`,
          };
        }
        continue;
      }
      out[canonical] = altValue;
    }
  }
  return { ok: true, args: out };
}
