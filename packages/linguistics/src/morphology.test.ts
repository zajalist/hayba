import { describe, expect, it } from 'vitest';
import {
  inflect, buildParadigm, enumerateAxes, findRuleConflicts,
  PRESET_PARADIGMS,
} from './morphology.js';
import type { AffixRule, ParadigmDef } from './morphology.js';

describe('enumerateAxes', () => {
  it('returns Cartesian product', () => {
    const def: ParadigmDef = { pos: 'noun', axes: { case: ['nom','acc'], number: ['sg','pl'] } };
    const targets = enumerateAxes(def);
    expect(targets).toHaveLength(4);
    expect(targets).toContainEqual({ case: 'nom', number: 'sg' });
    expect(targets).toContainEqual({ case: 'acc', number: 'pl' });
  });

  it('returns single empty target for empty axes', () => {
    expect(enumerateAxes({ pos: 'noun', axes: {} })).toEqual([{}]);
  });
});

describe('inflect', () => {
  const rules: AffixRule[] = [
    { pos: 'noun', condition: { case: 'nom', number: 'sg' }, position: 'suffix', form: 'a' },
    { pos: 'noun', condition: { case: 'gen', number: 'pl' }, position: 'suffix', form: 'arum' },
    { pos: 'verb', condition: { person: '3', number: 'sg' }, position: 'suffix', form: 's' },
  ];

  it('applies the matching rule', () => {
    expect(inflect('puell', 'noun', { case: 'nom', number: 'sg' }, rules).form).toBe('puella');
    expect(inflect('puell', 'noun', { case: 'gen', number: 'pl' }, rules).form).toBe('puellarum');
  });

  it('respects POS', () => {
    expect(inflect('walk', 'verb', { person: '3', number: 'sg' }, rules).form).toBe('walks');
  });

  it('returns stem unchanged when no rule matches', () => {
    expect(inflect('puell', 'noun', { case: 'voc', number: 'sg' }, rules).form).toBe('puell');
  });

  it('prefers more specific (more conditions) rule', () => {
    const rs: AffixRule[] = [
      { pos: 'noun', condition: { case: 'nom' }, position: 'suffix', form: 'X' },
      { pos: 'noun', condition: { case: 'nom', number: 'sg' }, position: 'suffix', form: 'Y' },
    ];
    expect(inflect('a', 'noun', { case: 'nom', number: 'sg' }, rs).form).toBe('aY');
  });

  it('priority overrides specificity', () => {
    const rs: AffixRule[] = [
      { pos: 'noun', condition: { case: 'nom', number: 'sg' }, position: 'suffix', form: 'Y' },
      { pos: 'noun', condition: { case: 'nom' }, position: 'suffix', form: 'X', priority: 10 },
    ];
    expect(inflect('a', 'noun', { case: 'nom', number: 'sg' }, rs).form).toBe('aX');
  });

  it('handles circumfix', () => {
    const rs: AffixRule[] = [
      { pos: 'verb', condition: { tense: 'past' }, position: 'circumfix', form: 'ge|t' },
    ];
    expect(inflect('lieb', 'verb', { tense: 'past' }, rs).form).toBe('geliebt');
  });

  it('handles prefix', () => {
    const rs: AffixRule[] = [
      { pos: 'verb', condition: { aspect: 'perf' }, position: 'prefix', form: 'pa' },
    ];
    expect(inflect('lulu', 'verb', { aspect: 'perf' }, rs).form).toBe('palulu');
  });

  it('handles replace (suppletion)', () => {
    const rs: AffixRule[] = [
      { pos: 'verb', condition: { tense: 'past' }, position: 'replace', form: 'went' },
    ];
    expect(inflect('go', 'verb', { tense: 'past' }, rs).form).toBe('went');
  });
});

describe('buildParadigm', () => {
  it('produces every cell in the axis product', () => {
    const preset = PRESET_PARADIGMS[0]!;
    const cells = buildParadigm(preset.exampleStem, preset.def, preset.rules);
    expect(cells).toHaveLength(10); // 5 cases × 2 numbers
    const nomSg = cells.find(c => c.target.case === 'nom' && c.target.number === 'sg');
    expect(nomSg?.form).toBe('puella');
    const genPl = cells.find(c => c.target.case === 'gen' && c.target.number === 'pl');
    expect(genPl?.form).toBe('puellarum');
  });
});

describe('findRuleConflicts', () => {
  it('reports cells where two rules tie at the top score', () => {
    const def: ParadigmDef = { pos: 'noun', axes: { case: ['nom'], number: ['sg'] } };
    const rs: AffixRule[] = [
      { pos: 'noun', condition: { case: 'nom', number: 'sg' }, position: 'suffix', form: 'A' },
      { pos: 'noun', condition: { case: 'nom', number: 'sg' }, position: 'suffix', form: 'B' },
    ];
    const conflicts = findRuleConflicts('x', def, rs);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.ruleIndices.sort()).toEqual([0, 1]);
  });

  it('does not report tie when one rule has higher priority', () => {
    const def: ParadigmDef = { pos: 'noun', axes: { case: ['nom'], number: ['sg'] } };
    const rs: AffixRule[] = [
      { pos: 'noun', condition: { case: 'nom', number: 'sg' }, position: 'suffix', form: 'A' },
      { pos: 'noun', condition: { case: 'nom', number: 'sg' }, position: 'suffix', form: 'B', priority: 5 },
    ];
    expect(findRuleConflicts('x', def, rs)).toHaveLength(0);
  });
});

describe('preset paradigms', () => {
  it('Latin 1st declension generates a complete consistent table', () => {
    const preset = PRESET_PARADIGMS[0]!;
    const cells = buildParadigm(preset.exampleStem, preset.def, preset.rules);
    const byKey: Record<string, string> = {};
    for (const c of cells) byKey[`${c.target.case}.${c.target.number}`] = c.form;
    expect(byKey['nom.sg']).toBe('puella');
    expect(byKey['gen.sg']).toBe('puellae');
    expect(byKey['acc.sg']).toBe('puellam');
    expect(byKey['gen.pl']).toBe('puellarum');
  });

  it('English present tense applies only the 3sg -s rule', () => {
    const preset = PRESET_PARADIGMS[1]!;
    const cells = buildParadigm(preset.exampleStem, preset.def, preset.rules);
    const byKey: Record<string, string> = {};
    for (const c of cells) byKey[`${c.target.person}.${c.target.number}`] = c.form;
    expect(byKey['3.sg']).toBe('walks');
    expect(byKey['1.sg']).toBe('walk');
    expect(byKey['2.pl']).toBe('walk');
  });
});
