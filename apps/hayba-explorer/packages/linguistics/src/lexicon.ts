/**
 * L3 — Lexicon store.
 *
 * Two implementations behind one interface:
 *   - `InMemoryLexicon` for tests and dev demos
 *   - `PostgresLexicon` — adapter point that a host app wires to its driver
 *
 * The schema mirrors the SQL migration in `migrations/0001_lexicon.sql`.
 */

/**
 * Part of speech. Open-set on the wire — we accept any string at the SQL
 * boundary so users can invent custom POS tags — but TypeScript callers get
 * the canonical 11-tag closed set for autocomplete.
 */
export type PartOfSpeech =
  | 'noun' | 'verb' | 'adjective' | 'adverb'
  | 'pronoun' | 'determiner' | 'preposition'
  | 'conjunction' | 'interjection' | 'numeral' | 'particle';

export const PARTS_OF_SPEECH: PartOfSpeech[] = [
  'noun', 'verb', 'adjective', 'adverb',
  'pronoun', 'determiner', 'preposition',
  'conjunction', 'interjection', 'numeral', 'particle',
];

/**
 * Morphosyntactic feature bundle. Open-ended `{ key: value }` map.
 * Conventional keys:
 *   nouns:      case, number, gender, definiteness, animacy
 *   verbs:      tense, aspect, mood, voice, person, number, polarity, evidentiality
 *   adjectives: degree, agreement (case/number/gender)
 *   pronouns:   person, number, gender, case, clusivity
 */
export type MorphFeatures = Readonly<Record<string, string>>;

export interface Lexeme {
  lemma: string;
  ipa: string;
  gloss: string;
  pos?: PartOfSpeech | string;
  morph?: MorphFeatures;
  register?: 'neutral' | 'formal' | 'slang' | 'poetic';
  etymology?: string;
}

export interface LexiconRepo {
  get(languageId: string, concept: string): Promise<Lexeme | null> | Lexeme | null;
  set(languageId: string, concept: string, entry: Lexeme): Promise<void> | void;
  /** Returns every lexeme for a language — used by the sound-change engine (L5). */
  all(languageId: string): Promise<Array<{ concept: string; entry: Lexeme }>> | Array<{ concept: string; entry: Lexeme }>;
  /** Optional: filter by POS. Implementations may return all() then filter, or push down to SQL. */
  byPos?(languageId: string, pos: string):
    Promise<Array<{ concept: string; entry: Lexeme }>> | Array<{ concept: string; entry: Lexeme }>;
}

export class InMemoryLexicon implements LexiconRepo {
  private readonly map = new Map<string, Lexeme>();

  private key(langId: string, concept: string): string {
    return `${langId}::${concept}`;
  }

  set(langId: string, concept: string, entry: Lexeme): void {
    this.map.set(this.key(langId, concept), entry);
  }

  get(langId: string, concept: string): Lexeme | null {
    return this.map.get(this.key(langId, concept)) ?? null;
  }

  all(langId: string): Array<{ concept: string; entry: Lexeme }> {
    const prefix = `${langId}::`;
    const out: Array<{ concept: string; entry: Lexeme }> = [];
    for (const [k, v] of this.map.entries()) {
      if (k.startsWith(prefix)) out.push({ concept: k.slice(prefix.length), entry: v });
    }
    return out;
  }

  byPos(langId: string, pos: string): Array<{ concept: string; entry: Lexeme }> {
    return this.all(langId).filter(({ entry }) => entry.pos === pos);
  }
}

/**
 * Back-compat alias retained so existing host code (MCP handlers) keeps
 * compiling while it migrates to `InMemoryLexicon` / `LexiconRepo`.
 */
export class LexiconStore extends InMemoryLexicon {
  /** Same as `get` but synchronous & non-null-fallback-style. */
  wordFor(langId: string, concept: string): Lexeme | null {
    return this.get(langId, concept);
  }
}

/**
 * Driver-agnostic Postgres adapter. Pass a minimal `Pool`-like client that
 * exposes `query(text, params) → { rows }` (matches `pg`, `postgres`,
 * Supabase JS, etc.). The schema lives in `migrations/0001_lexicon.sql`.
 */
export interface SqlClient {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export class PostgresLexicon implements LexiconRepo {
  constructor(private readonly client: SqlClient) {}

  async get(languageId: string, concept: string): Promise<Lexeme | null> {
    const { rows } = await this.client.query<{
      lemma: string; ipa: string;
      pos: string | null; morph: MorphFeatures | null;
      register: Lexeme['register']; etymology: string | null;
    }>(
      `SELECT lemma, ipa, pos, morph,
              COALESCE(register, 'neutral') AS register, etymology
       FROM language_lexicon WHERE language_id = $1 AND concept = $2`,
      [languageId, concept],
    );
    const r = rows[0]; if (!r) return null;
    return {
      lemma: r.lemma, ipa: r.ipa,
      gloss: concept,
      pos: r.pos ?? undefined,
      morph: r.morph ?? undefined,
      register: r.register,
      etymology: r.etymology ?? undefined,
    };
  }

  async set(languageId: string, concept: string, entry: Lexeme): Promise<void> {
    await this.client.query(
      `INSERT INTO language_lexicon (language_id, concept, lemma, ipa, pos, morph, register, etymology)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (language_id, concept) DO UPDATE SET
         lemma = EXCLUDED.lemma, ipa = EXCLUDED.ipa,
         pos = EXCLUDED.pos, morph = EXCLUDED.morph,
         register = EXCLUDED.register, etymology = EXCLUDED.etymology`,
      [
        languageId, concept, entry.lemma, entry.ipa,
        entry.pos ?? null,
        entry.morph ? JSON.stringify(entry.morph) : null,
        entry.register ?? null,
        entry.etymology ?? null,
      ],
    );
  }

  async all(languageId: string): Promise<Array<{ concept: string; entry: Lexeme }>> {
    const { rows } = await this.client.query<{
      concept: string; lemma: string; ipa: string;
      pos: string | null; morph: MorphFeatures | null;
      register: Lexeme['register']; etymology: string | null;
    }>(
      `SELECT concept, lemma, ipa, pos, morph, register, etymology
       FROM language_lexicon WHERE language_id = $1 ORDER BY concept`,
      [languageId],
    );
    return rows.map(r => ({
      concept: r.concept,
      entry: {
        lemma: r.lemma, ipa: r.ipa, gloss: r.concept,
        pos: r.pos ?? undefined, morph: r.morph ?? undefined,
        register: r.register,
        etymology: r.etymology ?? undefined,
      } as Lexeme,
    }));
  }

  /** Filter the lexicon by POS — useful for the Translator and grammar tools. */
  async byPos(languageId: string, pos: string): Promise<Array<{ concept: string; entry: Lexeme }>> {
    const { rows } = await this.client.query<{
      concept: string; lemma: string; ipa: string;
      pos: string | null; morph: MorphFeatures | null;
      register: Lexeme['register']; etymology: string | null;
    }>(
      `SELECT concept, lemma, ipa, pos, morph, register, etymology
       FROM language_lexicon WHERE language_id = $1 AND pos = $2 ORDER BY concept`,
      [languageId, pos],
    );
    return rows.map(r => ({
      concept: r.concept,
      entry: {
        lemma: r.lemma, ipa: r.ipa, gloss: r.concept,
        pos: r.pos ?? undefined, morph: r.morph ?? undefined,
        register: r.register, etymology: r.etymology ?? undefined,
      } as Lexeme,
    }));
  }
}
