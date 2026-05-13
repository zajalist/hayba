import { describe, expect, it } from 'vitest';
import type { Lexeme } from './lexicon.js';
import type { Phonology } from './phonology.js';
import type { PhonotacticSpec } from './phonotactics.js';
import type { RomanizationMap } from './romanization.js';
import {
  exportToCsv, exportToAnkiTsv, exportToMarkdown,
  type ExportContext,
} from './export-formats.js';

const phono: Phonology = {
  languageId: 'demo',
  phonemes: [
    { id: 'p', ipa: 'p', features: { place: 'bilabial', manner: 'plosive', voicing: 'voiceless' } },
    { id: 't', ipa: 't', features: { place: 'alveolar', manner: 'plosive', voicing: 'voiceless' } },
    { id: 'a', ipa: 'a', features: { height: 'open', backness: 'front', roundness: 'unrounded' } },
    { id: 'i', ipa: 'i', features: { height: 'close', backness: 'front', roundness: 'unrounded' } },
  ],
};

const spec: PhonotacticSpec = {
  phonologyId: 'demo',
  vowels: ['a', 'i'],
  syllable: { templates: ['CV', 'CVC'] },
};

const rom: RomanizationMap = {
  languageId: 'demo',
  rules: [['p', 'p'], ['t', 't'], ['a', 'a'], ['i', 'i']],
};

function lex(concept: string, lemma: string, extra: Partial<Lexeme> = {}): Lexeme & { concept: string } {
  return {
    concept, lemma, ipa: lemma, gloss: concept, ...extra,
  };
}

function ctx(lexicon: ReadonlyArray<Lexeme & { concept?: string }>): ExportContext {
  return { languageId: 'demo', lexicon, phonology: phono, phonotactics: spec, romanization: rom };
}

describe('exportToCsv', () => {
  it('emits a header row + one row per entry', () => {
    const out = exportToCsv(ctx([
      lex('sun', 'pata', { pos: 'noun', register: 'neutral' }),
      lex('moon', 'tipa', { pos: 'noun', register: 'poetic' }),
      lex('to-walk', 'ata', { pos: 'verb' }),
    ]));
    const rows = out.trimEnd().split('\r\n');
    expect(rows).toHaveLength(4); // header + 3
    expect(rows[0]).toBe('concept,lemma,ipa,romanized,pos,register,etymology');
  });

  it('quotes lemmas containing a comma', () => {
    const out = exportToCsv(ctx([lex('greeting', 'sa,la', { pos: 'interjection' })]));
    expect(out).toContain('"sa,la"');
  });

  it('escapes embedded double quotes per RFC-4180', () => {
    const out = exportToCsv(ctx([lex('quote', 'sa"la')]));
    expect(out).toContain('"sa""la"');
  });

  it('quotes fields containing newlines', () => {
    const out = exportToCsv(ctx([lex('multi', 'one\ntwo')]));
    expect(out).toContain('"one\ntwo"');
  });

  it('returns just the header row for an empty lexicon', () => {
    const out = exportToCsv(ctx([]));
    const rows = out.trimEnd().split('\r\n');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toBe('concept,lemma,ipa,romanized,pos,register,etymology');
  });

  it('handles entries missing optional fields without crashing', () => {
    const out = exportToCsv(ctx([lex('bare', 'pa')])); // no pos/register/etymology
    const rows = out.trimEnd().split('\r\n');
    expect(rows).toHaveLength(2);
    // Trailing commas for the empty optional fields.
    expect(rows[1].endsWith(',,,')).toBe(true);
  });
});

describe('exportToAnkiTsv', () => {
  it('emits a Front\\tBack header row + one line per entry, each with 2 columns', () => {
    const out = exportToAnkiTsv(ctx([
      lex('sun', 'pata', { pos: 'noun' }),
      lex('moon', 'tipa', { pos: 'noun' }),
    ]));
    const lines = out.trimEnd().split('\n');
    expect(lines[0]).toBe('Front\tBack');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.split('\t')).toHaveLength(2);
    }
  });

  it('encodes Back-cell newlines as <br>', () => {
    const out = exportToAnkiTsv(ctx([
      lex('sun', 'pata', { pos: 'noun', etymology: 'from proto-x' }),
    ]));
    const lines = out.trim().split('\n');
    const back = lines[1].split('\t')[1];
    expect(back).toContain('<br>');
    expect(back).not.toContain('\n');
  });

  it('handles entries with missing optional fields', () => {
    const out = exportToAnkiTsv(ctx([lex('bare', 'pa')]));
    const lines = out.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1].split('\t')).toHaveLength(2);
  });

  it('header-only output for an empty lexicon', () => {
    const out = exportToAnkiTsv(ctx([]));
    expect(out.trim()).toBe('Front\tBack');
  });
});

describe('exportToMarkdown', () => {
  it('starts with the language ID as the first heading', () => {
    const md = exportToMarkdown(ctx([lex('sun', 'pata', { pos: 'noun' })]));
    expect(md.split('\n')[0]).toBe('# demo');
  });

  it('contains a Dictionary section', () => {
    const md = exportToMarkdown(ctx([lex('sun', 'pata', { pos: 'noun' })]));
    expect(md).toContain('## Dictionary');
  });

  it('renders a subsection for every distinct POS', () => {
    const md = exportToMarkdown(ctx([
      lex('sun', 'pata', { pos: 'noun' }),
      lex('to-walk', 'ata', { pos: 'verb' }),
      lex('big', 'tap', { pos: 'adjective' }),
    ]));
    expect(md).toContain('### Nouns');
    expect(md).toContain('### Verbs');
    expect(md).toContain('### Adjectives');
  });

  it('groups untagged entries under "Other" rendered last', () => {
    const md = exportToMarkdown(ctx([
      lex('mystery', 'ipa'),
      lex('sun', 'pata', { pos: 'noun' }),
    ]));
    const otherIdx = md.indexOf('### Other');
    const nounIdx = md.indexOf('### Nouns');
    expect(otherIdx).toBeGreaterThan(-1);
    expect(nounIdx).toBeGreaterThan(-1);
    expect(otherIdx).toBeGreaterThan(nounIdx);
  });

  it('shows a placeholder when the lexicon is empty', () => {
    const md = exportToMarkdown(ctx([]));
    expect(md).toContain('## Dictionary');
    expect(md).toContain('Dictionary is empty');
    // Inventory section is still present.
    expect(md).toContain('## Phoneme inventory');
  });

  it('handles entries with missing optional fields without crashing', () => {
    const md = exportToMarkdown(ctx([lex('bare', 'pa')]));
    expect(md).toContain('**bare**');
  });

  it('lists phonotactic templates when provided', () => {
    const md = exportToMarkdown(ctx([lex('sun', 'pata', { pos: 'noun' })]));
    expect(md).toContain('`CV`');
    expect(md).toContain('`CVC`');
  });
});
