/**
 * L28 — Derivational morphology.
 *
 * Distinct from L11 inflection (which conjugates/declines existing lexemes)
 * and L7 derivation.ts (which is the LLM scaffold for proposing new lemmas).
 * Derivation rules coin *new* vocabulary by attaching productive affixes that
 * shift part-of-speech or semantics:
 *
 *   fish (noun) + agent-noun suffix "-er" → fisher (noun)
 *   build (verb) + repetitive prefix "re-"  → rebuild (verb)
 *   happy (adj) + intensifier circumfix "very-|-est" → very-happy-est
 *
 * Pure functions. The host UI decides which generated derivations to persist
 * back into the lexicon.
 */

import type { Lexeme, PartOfSpeech } from './lexicon.js';

export interface DerivationRule {
  /** POS the root must have for this rule to apply. */
  sourcePos: PartOfSpeech | string;
  /** POS of the derived lexeme. */
  resultPos: PartOfSpeech | string;
  /** Semantic shift label, e.g. "agent-noun", "repetitive", "intensifier". */
  kind: string;
  position: 'prefix' | 'suffix' | 'circumfix';
  /** Affix to apply. For circumfix, "pre|suf". */
  form: string;
  /** How likely this rule is to apply in practice. */
  productivity: 'productive' | 'semi-productive' | 'fossilised';
  /** Gloss template; "${root}" is substituted with the root's concept/gloss. */
  glossTemplate?: string;
  /** Optional priority — host UI may use to order rule list. */
  priority?: number;
  /** Human-readable label. */
  label?: string;
}

/** Apply a single derivation rule to a root lexeme. Throws on POS mismatch. */
export function deriveLexeme(root: Lexeme, rule: DerivationRule): Lexeme {
  if (root.pos !== rule.sourcePos) {
    throw new Error('derivation rule does not apply to this POS');
  }

  const surface = applyAffix(root.lemma, rule);
  const conceptOrGloss =
    (root as Lexeme & { concept?: string }).concept ?? root.gloss;
  const gloss = rule.glossTemplate
    ? rule.glossTemplate.replace(/\$\{root\}/g, conceptOrGloss)
    : `${conceptOrGloss}.${rule.kind}`;

  return {
    lemma: surface,
    ipa: surface,
    gloss,
    pos: rule.resultPos,
    etymology: `${conceptOrGloss} + ${rule.kind} (${rule.form})`,
    register: root.register,
  };
}

function applyAffix(stem: string, rule: DerivationRule): string {
  switch (rule.position) {
    case 'prefix': return rule.form + stem;
    case 'suffix': return stem + rule.form;
    case 'circumfix': {
      const [pre = '', suf = ''] = rule.form.split('|');
      return pre + stem + suf;
    }
  }
}

export interface DerivationOutput {
  root: Lexeme;
  rule: DerivationRule;
  derived: Lexeme;
}

/**
 * Cross-product (root × rule) over the lexicon. Yields one derivation per
 * matching pair. Fossilised rules are skipped unless `includeFossilised`.
 */
export function generateDerivations(
  lexicon: readonly Lexeme[],
  rules: readonly DerivationRule[],
  opts: { includeFossilised?: boolean } = {},
): DerivationOutput[] {
  const out: DerivationOutput[] = [];
  for (const rule of rules) {
    if (rule.productivity === 'fossilised' && !opts.includeFossilised) continue;
    for (const root of lexicon) {
      if (root.pos !== rule.sourcePos) continue;
      out.push({ root, rule, derived: deriveLexeme(root, rule) });
    }
  }
  return out;
}
