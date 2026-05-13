import { describe, expect, it } from 'vitest';
import { deriveLexeme, generateDerivations } from './derivation-rules.js';
import type { DerivationRule } from './derivation-rules.js';
import type { Lexeme } from './lexicon.js';

const fish: Lexeme = { lemma: 'fish', ipa: 'fish', gloss: 'fish', pos: 'noun' };
const build: Lexeme = { lemma: 'build', ipa: 'build', gloss: 'build', pos: 'verb' };
const happy: Lexeme = { lemma: 'happy', ipa: 'happy', gloss: 'happy', pos: 'adjective' };

const agentNounRule: DerivationRule = {
  sourcePos: 'noun', resultPos: 'noun', kind: 'agent-noun',
  position: 'suffix', form: '-er', productivity: 'productive',
  glossTemplate: '${root}-er',
};

const repetitiveRule: DerivationRule = {
  sourcePos: 'verb', resultPos: 'verb', kind: 'repetitive',
  position: 'prefix', form: 're-', productivity: 'productive',
  glossTemplate: 're-${root}',
};

const intensifierRule: DerivationRule = {
  sourcePos: 'adjective', resultPos: 'adjective', kind: 'intensifier',
  position: 'circumfix', form: 'very-|-est', productivity: 'productive',
  glossTemplate: 'very ${root} -est',
};

describe('deriveLexeme', () => {
  it('applies a suffix agent-noun rule', () => {
    const d = deriveLexeme(fish, agentNounRule);
    expect(d.lemma).toBe('fish-er');
    expect(d.pos).toBe('noun');
    expect(d.etymology).toBe('fish + agent-noun (-er)');
    expect(d.gloss).toBe('fish-er');
    expect(d.ipa).toBe('fish-er');
  });

  it('applies a prefix repetitive rule', () => {
    const d = deriveLexeme(build, repetitiveRule);
    expect(d.lemma).toBe('re-build');
    expect(d.pos).toBe('verb');
    expect(d.etymology).toBe('build + repetitive (re-)');
  });

  it('applies a circumfix intensifier rule', () => {
    const d = deriveLexeme(happy, intensifierRule);
    expect(d.lemma).toBe('very-happy-est');
    expect(d.pos).toBe('adjective');
    expect(d.etymology).toBe('happy + intensifier (very-|-est)');
  });

  it('throws on POS mismatch', () => {
    expect(() => deriveLexeme(fish, repetitiveRule))
      .toThrow('derivation rule does not apply to this POS');
  });

  it('substitutes glossTemplate', () => {
    const d = deriveLexeme(fish, agentNounRule);
    expect(d.gloss).toBe('fish-er');
  });

  it('falls back to default gloss when no template provided', () => {
    const ruleNoTemplate: DerivationRule = { ...agentNounRule, glossTemplate: undefined };
    const d = deriveLexeme(fish, ruleNoTemplate);
    expect(d.gloss).toBe('fish.agent-noun');
  });

  it('uses concept over gloss when available', () => {
    const withConcept = { ...fish, gloss: 'piscis' } as Lexeme & { concept: string };
    withConcept.concept = 'FISH';
    const d = deriveLexeme(withConcept, agentNounRule);
    expect(d.gloss).toBe('FISH-er');
    expect(d.etymology).toBe('FISH + agent-noun (-er)');
  });
});

describe('generateDerivations', () => {
  it('cross-products lexicon × rules by POS', () => {
    const lexicon: Lexeme[] = [
      { lemma: 'cat',   ipa: 'cat',   gloss: 'cat',   pos: 'noun' },
      { lemma: 'dog',   ipa: 'dog',   gloss: 'dog',   pos: 'noun' },
      { lemma: 'fish',  ipa: 'fish',  gloss: 'fish',  pos: 'noun' },
      { lemma: 'bird',  ipa: 'bird',  gloss: 'bird',  pos: 'noun' },
      { lemma: 'horse', ipa: 'horse', gloss: 'horse', pos: 'noun' },
      { lemma: 'run',   ipa: 'run',   gloss: 'run',   pos: 'verb' },
      { lemma: 'walk',  ipa: 'walk',  gloss: 'walk',  pos: 'verb' },
    ];
    // 5 nouns × 1 noun-rule = 5; 2 verbs × 1 verb-rule = 2; total 7.
    const results = generateDerivations(lexicon, [agentNounRule, repetitiveRule]);
    expect(results).toHaveLength(7);
    expect(results.filter(r => r.rule.kind === 'agent-noun')).toHaveLength(5);
    expect(results.filter(r => r.rule.kind === 'repetitive')).toHaveLength(2);
  });

  it('skips fossilised rules by default', () => {
    const lexicon: Lexeme[] = [fish];
    const fossil: DerivationRule = {
      ...agentNounRule, kind: 'old-agent', form: '-ster', productivity: 'fossilised',
    };
    const results = generateDerivations(lexicon, [agentNounRule, fossil]);
    expect(results).toHaveLength(1);
    expect(results[0]!.rule.kind).toBe('agent-noun');
  });

  it('includes fossilised rules when opt-in', () => {
    const lexicon: Lexeme[] = [fish];
    const fossil: DerivationRule = {
      ...agentNounRule, kind: 'old-agent', form: '-ster', productivity: 'fossilised',
    };
    const results = generateDerivations(lexicon, [agentNounRule, fossil], { includeFossilised: true });
    expect(results).toHaveLength(2);
  });
});
