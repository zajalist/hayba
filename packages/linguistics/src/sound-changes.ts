/**
 * L5 — Sound-change rule engine.
 *
 * Inspired by Lexurgy SCA. Each rule is one line:
 *
 *   p > b / V _ V          // /p/ → /b/ between vowels
 *   t > 0 / _ #             // /t/ deletes word-finally
 *   [+nasal] > 0 / _ #     // any nasal deletes word-finally (feature class)
 *
 * Grammar (this MVP):
 *   rule        := target ARROW replacement [SLASH context]
 *   target      := segment | feature-class
 *   replacement := segment | "0"
 *   context     := lhs "_" rhs
 *   lhs/rhs     := (segment | feature-class | "#")*
 *
 * Feature classes use a registered map (e.g. V, C, N) from the phonotactic
 * spec — same vocabulary as L2 templates.
 *
 * Application order: rules apply sequentially, top-to-bottom, each rule
 * scanning the word left-to-right until no further match. Bit-exact:
 * `applyRules(word, rules)` is pure.
 */

import type { Phonology } from './phonology.js';
import { tokenize } from './phonology.js';

export interface SoundChangeRule {
  /** Single phoneme IPA or `[X]` feature class. */
  target: string;
  /** Replacement IPA or "0" (deletion). */
  replacement: string;
  /** Left-context tokens (may be empty). */
  before: string[];
  /** Right-context tokens (may be empty). */
  after: string[];
  /** Original source text for error reporting. */
  source: string;
}

const RULE_RE = /^\s*([^\s>]+)\s*>\s*([^\s/]+)\s*(?:\/\s*(.*?)\s*_\s*(.*?))?\s*(?:\/\/.*)?$/;

export function parseRule(line: string): SoundChangeRule {
  const m = RULE_RE.exec(line);
  if (!m) throw new Error(`hayba: cannot parse sound-change rule: '${line}'`);
  const [, target, replacement, lhs = '', rhs = ''] = m;
  return {
    target: target!,
    replacement: replacement!,
    before: tokenizeContext(lhs),
    after: tokenizeContext(rhs),
    source: line.trim(),
  };
}

/**
 * Inverse of `parseRule`: emit canonical text for a rule AST.
 *
 * Round-trips with `parseRule` modulo whitespace + trailing comments:
 *   parseRule(stringifyRule(r))  →  structurally equal r (sans `source`)
 *
 * Canonical form: `target > replacement[ / before _ after]`. Multi-token
 * context lists are joined by a single space; an empty context slot stays
 * empty (no leading/trailing space inside the `/ … _ …` block).
 */
export function stringifyRule(rule: SoundChangeRule): string {
  const ctx = rule.before.length > 0 || rule.after.length > 0;
  const lhs = rule.before.join(' ');
  const rhs = rule.after.join(' ');
  const head = `${rule.target} > ${rule.replacement}`;
  if (!ctx) return head;
  return `${head} / ${lhs} _ ${rhs}`.replace(/  +/g, ' ').replace(/ +$/g, '');
}

export function parseRules(text: string): SoundChangeRule[] {
  return text
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('//') && !s.startsWith('#'))
    .map(parseRule);
}

function tokenizeContext(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '#') { out.push('#'); i++; continue; }
    if (ch === '[') {
      const end = s.indexOf(']', i);
      if (end < 0) throw new Error(`hayba: unbalanced '[' in context: '${s}'`);
      out.push(s.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    // Allow multi-char IPA tokens (digraphs) by greedy whitespace splitting fallback.
    out.push(ch);
    i++;
  }
  return out;
}

function isClass(token: string): boolean {
  return token.startsWith('[') && token.endsWith(']');
}

function classMatch(
  token: string,
  className: string,
  classes: Record<string, Set<string>>,
): boolean {
  // [+nasal] → "+nasal", look up in classes map by the bare letter? We accept
  // both `[X]` (uppercase shorthand for a registered class) and `[+feat]`
  // (literal feature, callers pre-resolve into the class map under "+feat").
  const key = className.slice(1, -1);
  const pool = classes[key];
  return pool ? pool.has(token) : false;
}

function tokenMatch(
  word: string[],
  idx: number,
  pat: string,
  classes: Record<string, Set<string>>,
): boolean {
  if (pat === '#') return idx === -1 || idx === word.length;
  if (idx < 0 || idx >= word.length) return false;
  if (isClass(pat)) return classMatch(word[idx]!, pat, classes);
  return word[idx] === pat;
}

function matchSequence(
  word: string[],
  start: number,
  pattern: string[],
  classes: Record<string, Set<string>>,
  direction: 'forward' | 'backward',
): boolean {
  if (direction === 'forward') {
    for (let k = 0; k < pattern.length; k++) {
      const tok = pattern[k]!;
      if (tok === '#') {
        if (start + k !== word.length) return false;
        continue;
      }
      if (!tokenMatch(word, start + k, tok, classes)) return false;
    }
  } else {
    for (let k = 0; k < pattern.length; k++) {
      const tok = pattern[pattern.length - 1 - k]!;
      const at = start - 1 - k;
      if (tok === '#') {
        if (at !== -1) return false;
        continue;
      }
      if (!tokenMatch(word, at, tok, classes)) return false;
    }
  }
  return true;
}

export function applyRule(
  word: string[],
  rule: SoundChangeRule,
  classes: Record<string, Set<string>>,
): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < word.length) {
    const tok = word[i]!;
    const targetHit = isClass(rule.target)
      ? classMatch(tok, rule.target, classes)
      : tok === rule.target;
    if (targetHit
        && matchSequence(word, i + 1, rule.after, classes, 'forward')
        && matchSequence(word, i, rule.before, classes, 'backward')) {
      if (rule.replacement !== '0') out.push(rule.replacement);
      i++;
    } else {
      out.push(tok); i++;
    }
  }
  return out;
}

/**
 * Apply each rule top-to-bottom over a word string. The word is tokenized
 * against the given phonology; class names are looked up from `classes`.
 */
export function evolveWord(
  word: string,
  phonology: Phonology,
  rules: SoundChangeRule[],
  classes: Record<string, Set<string>>,
): string {
  let tokens = tokenize(word, phonology);
  if (!tokens) throw new Error(`hayba: cannot tokenize '${word}' against inventory`);
  for (const rule of rules) {
    tokens = applyRule(tokens, rule, classes);
  }
  return tokens.join('');
}

/** Apply a rule stack to a whole lexicon (concept → lemma map). Returns the new lemmas. */
export function evolveLexicon(
  entries: Array<{ concept: string; lemma: string }>,
  phonology: Phonology,
  rules: SoundChangeRule[],
  classes: Record<string, Set<string>>,
): Array<{ concept: string; lemma: string; evolved: string }> {
  return entries.map(e => ({
    ...e,
    evolved: evolveWord(e.lemma, phonology, rules, classes),
  }));
}
