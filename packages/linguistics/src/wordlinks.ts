/**
 * L13 — Wordlinks. Cross-language translation graph.
 *
 * A wordlink ties concept C in language A to concept C′ in language B, with
 * a kind tag. Use cases:
 *   - Cognate: derived from a shared ancestor via sound change (auto-linked
 *     when a daughter language is forked from a parent).
 *   - Borrowing: copied across languages with phonological adaptation.
 *   - Calque: structural translation (lit. "loan translation").
 *   - Translation: equivalent meaning, no shared etymology.
 *
 * Wordlinks are undirected pairs but stored with a canonical order so
 * `link(a→b)` and `link(b→a)` collapse to the same row.
 */

export type WordlinkKind = 'cognate' | 'borrowing' | 'calque' | 'translation';

export interface Wordlink {
  langA: string;
  conceptA: string;
  langB: string;
  conceptB: string;
  kind: WordlinkKind;
  note?: string;
}

export interface WordlinkRepo {
  add(link: Wordlink): Promise<void> | void;
  remove(langA: string, conceptA: string, langB: string, conceptB: string):
    Promise<void> | void;
  /** All wordlinks involving (langId, concept) — either side of the pair. */
  for(langId: string, concept: string): Promise<Wordlink[]> | Wordlink[];
  /** All wordlinks for a language (any concept). */
  byLanguage(langId: string): Promise<Wordlink[]> | Wordlink[];
  all(): Promise<Wordlink[]> | Wordlink[];
}

/** Canonical ordering — same pair regardless of caller's argument order. */
function canon(link: Wordlink): Wordlink {
  if (link.langA < link.langB || (link.langA === link.langB && link.conceptA <= link.conceptB)) {
    return link;
  }
  return {
    langA: link.langB, conceptA: link.conceptB,
    langB: link.langA, conceptB: link.conceptA,
    kind: link.kind, note: link.note,
  };
}

function keyOf(l: Wordlink): string {
  const c = canon(l);
  return `${c.langA}::${c.conceptA}>>${c.langB}::${c.conceptB}`;
}

export class InMemoryWordlinks implements WordlinkRepo {
  private readonly map = new Map<string, Wordlink>();

  add(link: Wordlink): void {
    this.map.set(keyOf(link), canon(link));
  }

  remove(langA: string, conceptA: string, langB: string, conceptB: string): void {
    const c = canon({ langA, conceptA, langB, conceptB, kind: 'translation' });
    this.map.delete(keyOf(c));
  }

  for(langId: string, concept: string): Wordlink[] {
    const out: Wordlink[] = [];
    for (const link of this.map.values()) {
      if ((link.langA === langId && link.conceptA === concept) ||
          (link.langB === langId && link.conceptB === concept)) {
        out.push(link);
      }
    }
    return out;
  }

  byLanguage(langId: string): Wordlink[] {
    const out: Wordlink[] = [];
    for (const link of this.map.values()) {
      if (link.langA === langId || link.langB === langId) out.push(link);
    }
    return out;
  }

  all(): Wordlink[] {
    return [...this.map.values()];
  }
}

/**
 * Given two lexicons (parent + daughter) and a sound-change result mapping
 * concept → evolved lemma, emit wordlinks marking every concept-pair as
 * cognate. The expected input shape matches `evolveLexicon`'s output:
 *   [{ concept, lemma, evolved }, ...]
 */
export function autoCognatesFromDiachrony(
  parentLangId: string,
  daughterLangId: string,
  evolved: ReadonlyArray<{ concept: string; lemma: string; evolved: string }>,
): Wordlink[] {
  if (parentLangId === daughterLangId) return [];
  return evolved.map(e => ({
    langA: parentLangId,
    conceptA: e.concept,
    langB: daughterLangId,
    conceptB: e.concept,
    kind: 'cognate' as const,
    note: `${e.lemma} → ${e.evolved}`,
  }));
}

/* ─────────────────────  Postgres adapter  ───────────────────── */

import type { SqlClient } from './lexicon.js';

export class PostgresWordlinks implements WordlinkRepo {
  constructor(private readonly client: SqlClient) {}

  async add(link: Wordlink): Promise<void> {
    const c = canon(link);
    await this.client.query(
      `INSERT INTO language_wordlink (lang_a, concept_a, lang_b, concept_b, kind, note)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (lang_a, concept_a, lang_b, concept_b) DO UPDATE SET
         kind = EXCLUDED.kind, note = EXCLUDED.note`,
      [c.langA, c.conceptA, c.langB, c.conceptB, c.kind, c.note ?? null],
    );
  }

  async remove(langA: string, conceptA: string, langB: string, conceptB: string): Promise<void> {
    const c = canon({ langA, conceptA, langB, conceptB, kind: 'translation' });
    await this.client.query(
      `DELETE FROM language_wordlink
       WHERE lang_a = $1 AND concept_a = $2 AND lang_b = $3 AND concept_b = $4`,
      [c.langA, c.conceptA, c.langB, c.conceptB],
    );
  }

  async for(langId: string, concept: string): Promise<Wordlink[]> {
    const { rows } = await this.client.query<Wordlink>(
      `SELECT lang_a as "langA", concept_a as "conceptA",
              lang_b as "langB", concept_b as "conceptB",
              kind, note
       FROM language_wordlink
       WHERE (lang_a = $1 AND concept_a = $2)
          OR (lang_b = $1 AND concept_b = $2)`,
      [langId, concept],
    );
    return rows;
  }

  async byLanguage(langId: string): Promise<Wordlink[]> {
    const { rows } = await this.client.query<Wordlink>(
      `SELECT lang_a as "langA", concept_a as "conceptA",
              lang_b as "langB", concept_b as "conceptB",
              kind, note
       FROM language_wordlink WHERE lang_a = $1 OR lang_b = $1`,
      [langId],
    );
    return rows;
  }

  async all(): Promise<Wordlink[]> {
    const { rows } = await this.client.query<Wordlink>(
      `SELECT lang_a as "langA", concept_a as "conceptA",
              lang_b as "langB", concept_b as "conceptB",
              kind, note
       FROM language_wordlink`, [],
    );
    return rows;
  }
}
