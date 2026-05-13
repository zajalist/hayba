/**
 * L11 — Morphology engine.
 *
 * Defines affix rules per POS + morphosyntactic conditions, then derives
 * paradigm tables for any lemma. Pure functions — no globals.
 *
 *   Latin-style first-declension feminine:
 *     paradigm { axes: { case: [nom,gen,dat,acc,abl], number: [sg,pl] } }
 *     rule { pos: 'noun', condition: {case:'nom',number:'sg'}, position:'suffix', form: 'a' }
 *     rule { pos: 'noun', condition: {case:'gen',number:'sg'}, position:'suffix', form: 'ae' }
 *     rule { pos: 'noun', condition: {case:'acc',number:'sg'}, position:'suffix', form: 'am' }
 *     rule { pos: 'noun', condition: {case:'nom',number:'pl'}, position:'suffix', form: 'ae' }
 *     rule { pos: 'noun', condition: {case:'gen',number:'pl'}, position:'suffix', form: 'arum' }
 *
 *   inflect('puell', {case:'gen',number:'pl'}, rules) → 'puellarum'
 *
 * The engine treats stems opaquely: it doesn't care that 'puell' isn't a
 * real lemma. Strip the lemma's citation suffix yourself before calling, or
 * supply rules whose conditions match the lemma's natural shape.
 */

import type { PartOfSpeech } from './lexicon.js';

export type AffixPosition = 'prefix' | 'suffix' | 'circumfix' | 'replace' | 'infix';

export interface AffixRule {
  /** POS the rule applies to. */
  pos: PartOfSpeech | string;
  /** Subset of target morph features that must match. Empty = always applies. */
  condition: Readonly<Record<string, string>>;
  position: AffixPosition;
  /** For prefix/suffix/replace: the form to attach. For circumfix: "pref|suf". */
  form: string;
  /** Higher priority wins when multiple rules match the same target. */
  priority?: number;
  /** Optional human-readable tag for the UI. */
  label?: string;
}

export interface ParadigmDef {
  pos: PartOfSpeech | string;
  /** axes describe the table dimensions — order matters for table rendering. */
  axes: Readonly<Record<string, readonly string[]>>;
}

export type MorphTarget = Readonly<Record<string, string>>;

export interface ParadigmCell {
  target: MorphTarget;
  form: string;
  /** Which rule(s) produced this cell, by index in the input rule list. */
  ruleIndices: number[];
}

/** Cartesian product of paradigm axes — all combinations. */
export function enumerateAxes(def: ParadigmDef): MorphTarget[] {
  const entries = Object.entries(def.axes);
  if (entries.length === 0) return [{}];
  let acc: MorphTarget[] = [{}];
  for (const [key, vals] of entries) {
    const next: MorphTarget[] = [];
    for (const t of acc) for (const v of vals) next.push({ ...t, [key]: v });
    acc = next;
  }
  return acc;
}

/** Does `rule.condition` match every key in `target`? */
function ruleMatches(rule: AffixRule, target: MorphTarget): boolean {
  for (const [k, v] of Object.entries(rule.condition)) {
    if (target[k] !== v) return false;
  }
  return true;
}

/** Apply a single rule's form to a stem. */
function applyForm(stem: string, rule: AffixRule): string {
  switch (rule.position) {
    case 'prefix':    return rule.form + stem;
    case 'suffix':    return stem + rule.form;
    case 'replace':   return rule.form;
    case 'circumfix': {
      const [pre = '', suf = ''] = rule.form.split('|');
      return pre + stem + suf;
    }
    case 'infix': {
      // Naive infix: insert after first vowel-like glyph (a/e/i/o/u/y) if any.
      const m = stem.match(/[aeiouyɑɒɛɪɔʊəɨʉ]/i);
      if (!m || m.index === undefined) return stem + rule.form;
      const idx = m.index + 1;
      return stem.slice(0, idx) + rule.form + stem.slice(idx);
    }
  }
}

/**
 * Inflect a stem to the given target features against a rule list. Highest
 * priority matching rule wins; on a tie, latest wins. If no rule matches,
 * returns the stem unchanged.
 */
export function inflect(
  stem: string,
  pos: PartOfSpeech | string,
  target: MorphTarget,
  rules: readonly AffixRule[],
): { form: string; ruleIndices: number[] } {
  const candidates: Array<{ idx: number; rule: AffixRule; score: number }> = [];
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i]!;
    if (r.pos !== pos) continue;
    if (!ruleMatches(r, target)) continue;
    // Score = (priority || 0) * 1000 + condition specificity (more keys = more specific) * 10 + index.
    const score = (r.priority ?? 0) * 1000 + Object.keys(r.condition).length * 10 + i;
    candidates.push({ idx: i, rule: r, score });
  }
  if (candidates.length === 0) return { form: stem, ruleIndices: [] };
  candidates.sort((a, b) => b.score - a.score);
  const winner = candidates[0]!;
  return { form: applyForm(stem, winner.rule), ruleIndices: [winner.idx] };
}

/** Build the full paradigm table for a stem against a definition + rule list. */
export function buildParadigm(
  stem: string,
  def: ParadigmDef,
  rules: readonly AffixRule[],
): ParadigmCell[] {
  const targets = enumerateAxes(def);
  return targets.map(target => {
    const { form, ruleIndices } = inflect(stem, def.pos, target, rules);
    return { target, form, ruleIndices };
  });
}

/** Identify cells where two or more rules tie for the top score — UI conflict marker. */
/**
 * A "conflict" is a cell where two or more rules tie on (priority, specificity)
 * — i.e. only the rule-order index distinguishes them. Surface those so the
 * UI can warn the user to add a priority or a discriminating condition.
 */
export function findRuleConflicts(
  stem: string,
  def: ParadigmDef,
  rules: readonly AffixRule[],
): Array<{ target: MorphTarget; ruleIndices: number[] }> {
  const conflicts: Array<{ target: MorphTarget; ruleIndices: number[] }> = [];
  for (const target of enumerateAxes(def)) {
    const matches: Array<{ idx: number; coreScore: number }> = [];
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i]!;
      if (r.pos !== def.pos) continue;
      if (!ruleMatches(r, target)) continue;
      // coreScore excludes the index tie-breaker — only priority + specificity.
      const coreScore = (r.priority ?? 0) * 1000 + Object.keys(r.condition).length * 10;
      matches.push({ idx: i, coreScore });
    }
    if (matches.length < 2) continue;
    matches.sort((a, b) => b.coreScore - a.coreScore);
    const top = matches[0]!.coreScore;
    const tied = matches.filter(m => m.coreScore === top);
    if (tied.length > 1) {
      conflicts.push({ target, ruleIndices: tied.map(t => t.idx) });
    }
  }
  return conflicts;
}

/* ─────────────────────  Axis CRUD helpers  ─────────────────────
 *
 * The Grammar UI lets users edit paradigm axes interactively (add/remove an
 * axis, add/remove a value). These helpers keep that work pure: they take a
 * ParadigmDef and return a *new* def without mutating the input. The UI also
 * needs to know which existing rules become unreachable after a value is
 * removed — `prunedRulesAfterAxisChange` reports that.
 */

/** Add a new axis with the given values. No-op if `name` already exists. */
export function addAxis(
  def: ParadigmDef,
  name: string,
  values: readonly string[],
): ParadigmDef {
  const clean = name.trim();
  if (!clean) return def;
  if (Object.prototype.hasOwnProperty.call(def.axes, clean)) return def;
  const vs = values.map(v => v.trim()).filter(v => v.length > 0);
  if (vs.length === 0) return def;
  return { ...def, axes: { ...def.axes, [clean]: vs } };
}

/** Remove an axis by name. Returns the same def if the axis doesn't exist. */
export function removeAxis(def: ParadigmDef, name: string): ParadigmDef {
  if (!Object.prototype.hasOwnProperty.call(def.axes, name)) return def;
  const next: Record<string, readonly string[]> = {};
  for (const [k, v] of Object.entries(def.axes)) {
    if (k !== name) next[k] = v;
  }
  return { ...def, axes: next };
}

/** Append a value to an existing axis. No-op if axis missing or value exists. */
export function addAxisValue(
  def: ParadigmDef,
  axis: string,
  value: string,
): ParadigmDef {
  const v = value.trim();
  if (!v) return def;
  const cur = def.axes[axis];
  if (!cur) return def;
  if (cur.includes(v)) return def;
  return { ...def, axes: { ...def.axes, [axis]: [...cur, v] } };
}

/** Remove a value from an existing axis. No-op if axis or value missing. */
export function removeAxisValue(
  def: ParadigmDef,
  axis: string,
  value: string,
): ParadigmDef {
  const cur = def.axes[axis];
  if (!cur || !cur.includes(value)) return def;
  return { ...def, axes: { ...def.axes, [axis]: cur.filter(x => x !== value) } };
}

/* ─────────────────────  Built-in starter paradigms  ───────────────────── */

/**
 * A couple of preset paradigms users can start from. These are intentionally
 * minimal — production conlangs will diverge. The UI exposes them as "Load
 * preset" buttons in the Grammar tab.
 */
export const PRESET_PARADIGMS: Array<{
  name: string;
  def: ParadigmDef;
  exampleStem: string;
  rules: AffixRule[];
}> = [
  {
    name: 'Latin-style 1st declension (feminine nouns)',
    def: {
      pos: 'noun',
      axes: { case: ['nom','gen','dat','acc','abl'], number: ['sg','pl'] },
    },
    exampleStem: 'puell',
    rules: [
      { pos: 'noun', condition: { case: 'nom', number: 'sg' }, position: 'suffix', form: 'a',     label: 'nom.sg' },
      { pos: 'noun', condition: { case: 'gen', number: 'sg' }, position: 'suffix', form: 'ae',    label: 'gen.sg' },
      { pos: 'noun', condition: { case: 'dat', number: 'sg' }, position: 'suffix', form: 'ae',    label: 'dat.sg' },
      { pos: 'noun', condition: { case: 'acc', number: 'sg' }, position: 'suffix', form: 'am',    label: 'acc.sg' },
      { pos: 'noun', condition: { case: 'abl', number: 'sg' }, position: 'suffix', form: 'ā',     label: 'abl.sg' },
      { pos: 'noun', condition: { case: 'nom', number: 'pl' }, position: 'suffix', form: 'ae',    label: 'nom.pl' },
      { pos: 'noun', condition: { case: 'gen', number: 'pl' }, position: 'suffix', form: 'arum',  label: 'gen.pl' },
      { pos: 'noun', condition: { case: 'dat', number: 'pl' }, position: 'suffix', form: 'is',    label: 'dat.pl' },
      { pos: 'noun', condition: { case: 'acc', number: 'pl' }, position: 'suffix', form: 'as',    label: 'acc.pl' },
      { pos: 'noun', condition: { case: 'abl', number: 'pl' }, position: 'suffix', form: 'is',    label: 'abl.pl' },
    ],
  },
  {
    name: 'English-style present-tense verb',
    def: {
      pos: 'verb',
      axes: { person: ['1','2','3'], number: ['sg','pl'] },
    },
    exampleStem: 'walk',
    rules: [
      { pos: 'verb', condition: { person: '3', number: 'sg' }, position: 'suffix', form: 's', label: '3sg -s' },
      // Empty conditions never match this strictly, but a catch-all with priority 0
      // would let us implement bare-stem in all other cells. Keep it explicit.
      { pos: 'verb', condition: { person: '1', number: 'sg' }, position: 'suffix', form: '',  label: '1sg ∅' },
      { pos: 'verb', condition: { person: '2', number: 'sg' }, position: 'suffix', form: '',  label: '2sg ∅' },
      { pos: 'verb', condition: { person: '1', number: 'pl' }, position: 'suffix', form: '',  label: '1pl ∅' },
      { pos: 'verb', condition: { person: '2', number: 'pl' }, position: 'suffix', form: '',  label: '2pl ∅' },
      { pos: 'verb', condition: { person: '3', number: 'pl' }, position: 'suffix', form: '',  label: '3pl ∅' },
    ],
  },
];
