/**
 * L25 — Allophony engine.
 *
 * A phoneme has multiple **surface realizations** depending on its environment
 * (e.g. English /t/ → [ɾ] / [V] _ [V] — intervocalic flap). Distinct from L5
 * sound changes: allophony rules apply **every time the word is rendered**
 * (synchronic), not as historical evolution.
 *
 * The rule grammar is identical to L5 (`target > replacement / before _ after`)
 * — same matcher, same class vocabulary. The only new dimension is `priority`:
 * when multiple rules match the same token, the highest priority wins
 * (ties broken by rule-list order).
 *
 * Output: in addition to the surface word, we return a `mapping` array
 * — one entry per input token — so the UI can colour-code which segments
 * were realized differently.
 */

import type { Phonology } from './phonology.js';
import { tokenize } from './phonology.js';
import {
  classMatch,
  isClass,
  matchSequence,
  parseRule,
  type SoundChangeRule,
} from './sound-changes.js';

export interface AllophonyRule {
  /** Underlying phoneme or `[X]` feature class. */
  phoneme: string;
  /** Surface form (may include diacritics not in the inventory). */
  surface: string;
  /** Left-context tokens (may be empty). */
  before: string[];
  /** Right-context tokens (may be empty). */
  after: string[];
  /** Higher wins. Default 0. Ties broken by rule-list order. */
  priority?: number;
  /** Optional human label for debugging / UI. */
  label?: string;
}

export interface SurfaceMapping {
  /** The underlying phoneme token at this position. */
  underlying: string;
  /** The surface form actually emitted (== `underlying` when no rule fired). */
  surface: string;
  /** Index into the rule list that fired, or `undefined` if none matched. */
  ruleIdx?: number;
}

/**
 * Convert an `AllophonyRule` into the `SoundChangeRule` shape so we can
 * piggy-back on the existing L5 context matcher.
 */
function asSCA(rule: AllophonyRule): SoundChangeRule {
  return {
    target: rule.phoneme,
    replacement: rule.surface,
    before: rule.before,
    after: rule.after,
    source: rule.label ?? `${rule.phoneme} > ${rule.surface}`,
  };
}

/**
 * Parse a Lexurgy-style rule block as allophony rules. Same grammar as L5
 * (`target > replacement / before _ after`); each rule gets `priority: 0`
 * and no label by default.
 */
export function parseAllophonyRules(text: string): AllophonyRule[] {
  return text
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('//') && !s.startsWith('#'))
    .map(line => {
      const r = parseRule(line);
      return {
        phoneme: r.target,
        surface: r.replacement,
        before: r.before,
        after: r.after,
      };
    });
}

/** Does this rule's underlying-phoneme spec match the token at `idx`? */
function targetMatches(
  rule: AllophonyRule,
  word: string[],
  idx: number,
  classes: Record<string, Set<string>>,
): boolean {
  const tok = word[idx]!;
  if (isClass(rule.phoneme)) return classMatch(tok, rule.phoneme, classes);
  return tok === rule.phoneme;
}

/**
 * Apply allophony rules to a word. Returns both the rebuilt surface string
 * and a parallel mapping showing which underlying token became which surface.
 *
 * Semantics (per token):
 *   1. Find every rule whose target + context matches at this position.
 *   2. Pick the highest-priority match; ties broken by rule-list order
 *      (earlier in the list wins).
 *   3. Emit the rule's `surface` form; otherwise pass the token through.
 *
 * The matcher is single-pass — earlier emissions never feed later rules.
 * That mirrors how allophony actually works: it's a synchronic surface
 * pass, not a chained derivation.
 */
export function applyAllophony(
  word: string,
  phonology: Phonology,
  rules: readonly AllophonyRule[],
  classes: Record<string, Set<string>>,
): { surface: string; mapping: SurfaceMapping[] } {
  const tokens = tokenize(word, phonology);
  if (!tokens) {
    throw new Error(`hayba: cannot tokenize '${word}' against inventory`);
  }
  const mapping: SurfaceMapping[] = [];
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    let winner: { rule: AllophonyRule; idx: number } | undefined;
    for (let r = 0; r < rules.length; r++) {
      const rule = rules[r]!;
      if (!targetMatches(rule, tokens, i, classes)) continue;
      if (!matchSequence(tokens, i + 1, rule.after, classes, 'forward')) continue;
      if (!matchSequence(tokens, i, rule.before, classes, 'backward')) continue;
      const p = rule.priority ?? 0;
      const wp = winner ? (winner.rule.priority ?? 0) : -Infinity;
      // Strictly greater priority wins; ties stay with the earlier rule.
      if (!winner || p > wp) winner = { rule, idx: r };
    }
    if (winner) {
      out.push(winner.rule.surface);
      mapping.push({ underlying: tok, surface: winner.rule.surface, ruleIdx: winner.idx });
    } else {
      out.push(tok);
      mapping.push({ underlying: tok, surface: tok });
    }
  }
  // Surface forms may contain diacritics that aren't in the inventory; we
  // intentionally don't re-tokenize. Surface is for display only.
  return { surface: out.join(''), mapping };
}

/** Convenience: just the surface string. */
export function surfaceOf(
  word: string,
  phonology: Phonology,
  rules: readonly AllophonyRule[],
  classes: Record<string, Set<string>>,
): string {
  return applyAllophony(word, phonology, rules, classes).surface;
}

/**
 * Round-trip helper for hosts that want to persist rules as text: takes the
 * canonical SCA grammar and yields it back. Drafts (missing phoneme or
 * surface) become `// (draft rule)` placeholders so the text survives a
 * visual/text round-trip.
 */
export function stringifyAllophonyRule(rule: AllophonyRule): string {
  if (!rule.phoneme || !rule.surface) return '// (draft rule)';
  const ctx = rule.before.length > 0 || rule.after.length > 0;
  const head = `${rule.phoneme} > ${rule.surface}`;
  if (!ctx) return head;
  const lhs = rule.before.join(' ');
  const rhs = rule.after.join(' ');
  return `${head} / ${lhs} _ ${rhs}`.replace(/  +/g, ' ').replace(/ +$/g, '');
}
