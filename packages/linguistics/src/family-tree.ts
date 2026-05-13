/**
 * L14 — Family tree. Build a parent → daughter forest from cognate wordlinks.
 *
 * Heuristic
 * ─────────
 * A cognate wordlink emitted by `autoCognatesFromDiachrony(parent, daughter, …)`
 * puts the parent in `langA`, the daughter in `langB`, and carries a `note`
 * of the form `"<parentLemma> → <daughterLemma>"`. The demo pushes these
 * directly into `state.wordlinks` (it does *not* go through `InMemoryWordlinks`,
 * so canonical re-ordering does *not* apply). We therefore treat `langA` as the
 * parent and `langB` as the daughter for every `kind === 'cognate'` link.
 *
 * A language with no incoming "I am someone's daughter" edge is a root. Most
 * trees will be a single root with one chain of daughters or a few sisters,
 * but `buildFamilyTree` returns an array of roots in case the user has spun
 * up multiple unrelated families.
 *
 * For every parent→daughter edge we surface a "rule summary" — the single
 * cognate pair with the largest edit distance between parent lemma and
 * daughter lemma. That gives the UI a one-glance "the biggest change here
 * was X → Y" caption per edge.
 */

import type { Wordlink } from './wordlinks.js';

export interface SampleChange {
  /** Concept the change is illustrated on. */
  concept: string;
  /** Parent lemma (left side of the `note` arrow). */
  lemma: string;
  /** Daughter lemma (right side of the `note` arrow). */
  evolved: string;
}

export interface LanguageTreeNode {
  id: string;
  children: LanguageTreeNode[];
  parentId?: string;
  /** Human-readable summary of the most-changed cognate (e.g. "pipapa → piba"). */
  ruleSummary?: string;
  /** Literal lemma/evolved pair from the most-changed cognate. */
  sampleChange?: SampleChange;
}

interface ParentEdgeInfo {
  bestChange?: SampleChange;
  bestDistance: number;
}

/** Levenshtein edit distance. Small inputs — straightforward DP is fine. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1,
        curr[j - 1]! + 1,
        prev[j - 1]! + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

/** Parse a `"<lemma> → <evolved>"` note. Returns undefined if it doesn't match. */
function parseCognateNote(note: string | undefined): { lemma: string; evolved: string } | undefined {
  if (!note) return undefined;
  // The auto-cognate emitter uses U+2192 (→) but be defensive about plain "->" too.
  const idx = note.indexOf('→');
  const sep = idx >= 0 ? '→' : (note.indexOf('->') >= 0 ? '->' : null);
  if (!sep) return undefined;
  const pos = note.indexOf(sep);
  const lemma = note.slice(0, pos).trim();
  const evolved = note.slice(pos + sep.length).trim();
  if (!lemma || !evolved) return undefined;
  return { lemma, evolved };
}

/**
 * Build a forest of `LanguageTreeNode` from the given languages and wordlinks.
 *
 * Returns the roots (languages with no inferred parent). Every languageId is
 * placed exactly once. Languages that appear in `languageIds` but are not
 * referenced by any cognate wordlink show up as singleton roots.
 */
export function buildFamilyTree(
  languageIds: ReadonlyArray<string>,
  wordlinks: ReadonlyArray<Wordlink>,
): LanguageTreeNode[] {
  // Build parent → daughter edges from cognate wordlinks. Multiple wordlinks
  // between the same (parent, daughter) pair are folded into one edge whose
  // rule summary is taken from the cognate with the largest edit distance.
  const edges = new Map<string, Map<string, ParentEdgeInfo>>();
  // Track every language we see in cognate wordlinks so we still surface
  // languages the caller didn't list in `languageIds` (defensive).
  const seen = new Set<string>(languageIds);
  // For cycle/multi-parent prevention: each language can only have one parent
  // (the first one we encounter wins — ties are vanishingly unlikely in practice).
  const parentOf = new Map<string, string>();

  for (const link of wordlinks) {
    if (link.kind !== 'cognate') continue;
    const parent = link.langA;
    const daughter = link.langB;
    if (parent === daughter) continue;
    seen.add(parent); seen.add(daughter);

    let m = edges.get(parent);
    if (!m) { m = new Map(); edges.set(parent, m); }
    let info = m.get(daughter);
    if (!info) { info = { bestDistance: -1 }; m.set(daughter, info); }

    const parsed = parseCognateNote(link.note);
    if (parsed) {
      const d = editDistance(parsed.lemma, parsed.evolved);
      if (d > info.bestDistance) {
        info.bestDistance = d;
        info.bestChange = { concept: link.conceptA, lemma: parsed.lemma, evolved: parsed.evolved };
      }
    }

    // Pin the parent of `daughter` — first writer wins. Don't reparent if
    // the daughter is already someone else's child (avoids accidental cycles
    // when the user has linked two languages in both directions).
    if (!parentOf.has(daughter) && daughter !== parent) {
      // Also avoid creating a cycle: if `parent` is (transitively) a
      // descendant of `daughter` already, skip.
      if (!isAncestor(daughter, parent, parentOf)) {
        parentOf.set(daughter, parent);
      }
    }
  }

  // Materialise nodes.
  const nodes = new Map<string, LanguageTreeNode>();
  for (const id of seen) nodes.set(id, { id, children: [] });

  for (const [daughter, parent] of parentOf.entries()) {
    const dn = nodes.get(daughter)!;
    const pn = nodes.get(parent)!;
    dn.parentId = parent;
    const info = edges.get(parent)?.get(daughter);
    if (info?.bestChange) {
      dn.sampleChange = info.bestChange;
      dn.ruleSummary = `${info.bestChange.lemma} → ${info.bestChange.evolved}`;
    }
    pn.children.push(dn);
  }

  // Stable child order: alphabetical by id, so sister-language tests are deterministic.
  for (const n of nodes.values()) {
    n.children.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  const roots: LanguageTreeNode[] = [];
  for (const id of seen) {
    // Languages that turned up in wordlinks but weren't in the caller's
    // requested set still need to show — they're real languages in the data.
    const n = nodes.get(id)!;
    if (!n.parentId) roots.push(n);
  }
  roots.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return roots;
}

/** True iff `maybeAncestor` is an ancestor of `node` in the parent map. */
function isAncestor(maybeAncestor: string, node: string, parentOf: Map<string, string>): boolean {
  let cur: string | undefined = node;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    const p = parentOf.get(cur);
    if (p === maybeAncestor) return true;
    cur = p;
  }
  return false;
}
