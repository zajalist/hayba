export interface Lexeme {
  lemma: string;
  ipa: string;
  gloss: string;
  register?: 'neutral' | 'formal' | 'slang' | 'poetic';
  etymology?: string;
}

/** Process-local lexicon — swap for Postgres-backed repo later (issue L3). */
export class LexiconStore {
  private readonly map = new Map<string, Lexeme>();

  private key(langId: string, conceptId: string): string {
    return `${langId}::${conceptId}`;
  }

  set(langId: string, conceptId: string, entry: Lexeme): void {
    this.map.set(this.key(langId, conceptId), entry);
  }

  get(langId: string, conceptId: string): Lexeme | undefined {
    return this.map.get(this.key(langId, conceptId));
  }

  /** Deterministic: same (lang, concept) always returns stored lemma. */
  wordFor(langId: string, conceptId: string): Lexeme | null {
    return this.get(langId, conceptId) ?? null;
  }
}
