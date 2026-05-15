/**
 * L3 — Lexicon store.
 *
 * Two implementations behind one interface:
 *   - `InMemoryLexicon` for tests and dev demos
 *   - `PostgresLexicon` — adapter point that a host app wires to its driver
 *
 * The schema mirrors the SQL migration in `migrations/0001_lexicon.sql`.
 */

export interface Lexeme {
  lemma: string;
  ipa: string;
  gloss: string;
  register?: 'neutral' | 'formal' | 'slang' | 'poetic';
  etymology?: string;
}

export interface LexiconRepo {
  get(languageId: string, concept: string): Promise<Lexeme | null> | Lexeme | null;
  set(languageId: string, concept: string, entry: Lexeme): Promise<void> | void;
  /** Returns every lexeme for a language — used by the sound-change engine (L5). */
  all(languageId: string): Promise<Array<{ concept: string; entry: Lexeme }>> | Array<{ concept: string; entry: Lexeme }>;
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
    const { rows } = await this.client.query<Lexeme & { register: Lexeme['register'] }>(
      `SELECT lemma, ipa, COALESCE(register, 'neutral') AS register, etymology
       FROM language_lexicon WHERE language_id = $1 AND concept = $2`,
      [languageId, concept],
    );
    return rows[0] ?? null;
  }

  async set(languageId: string, concept: string, entry: Lexeme): Promise<void> {
    await this.client.query(
      `INSERT INTO language_lexicon (language_id, concept, lemma, ipa, register, etymology)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (language_id, concept) DO UPDATE SET
         lemma = EXCLUDED.lemma, ipa = EXCLUDED.ipa,
         register = EXCLUDED.register, etymology = EXCLUDED.etymology`,
      [languageId, concept, entry.lemma, entry.ipa, entry.register ?? null, entry.etymology ?? null],
    );
  }

  async all(languageId: string): Promise<Array<{ concept: string; entry: Lexeme }>> {
    const { rows } = await this.client.query<{ concept: string; lemma: string; ipa: string; register: Lexeme['register']; etymology: string | null }>(
      `SELECT concept, lemma, ipa, register, etymology
       FROM language_lexicon WHERE language_id = $1 ORDER BY concept`,
      [languageId],
    );
    return rows.map(r => ({
      concept: r.concept,
      entry: { lemma: r.lemma, ipa: r.ipa, register: r.register, etymology: r.etymology ?? undefined } as Lexeme,
    }));
  }
}
