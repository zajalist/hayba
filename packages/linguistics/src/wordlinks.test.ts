import { describe, expect, it } from 'vitest';
import { InMemoryWordlinks, autoCognatesFromDiachrony } from './wordlinks.js';

describe('wordlinks — InMemoryWordlinks', () => {
  it('stores a wordlink and retrieves it by concept on either side', () => {
    const wl = new InMemoryWordlinks();
    wl.add({ langA: 'proto', conceptA: 'mountain', langB: 'daughter', conceptB: 'mountain', kind: 'cognate' });
    expect(wl.for('proto', 'mountain')).toHaveLength(1);
    expect(wl.for('daughter', 'mountain')).toHaveLength(1);
    expect(wl.for('proto', 'nope')).toHaveLength(0);
  });

  it('canonicalises argument order — link(a,b) == link(b,a)', () => {
    const wl = new InMemoryWordlinks();
    wl.add({ langA: 'lang-b', conceptA: 'x', langB: 'lang-a', conceptB: 'y', kind: 'translation' });
    wl.add({ langA: 'lang-a', conceptA: 'y', langB: 'lang-b', conceptB: 'x', kind: 'translation' });
    expect(wl.all()).toHaveLength(1);
  });

  it('upserts: re-adding a pair updates the kind', () => {
    const wl = new InMemoryWordlinks();
    wl.add({ langA: 'a', conceptA: 'x', langB: 'b', conceptB: 'x', kind: 'translation' });
    wl.add({ langA: 'a', conceptA: 'x', langB: 'b', conceptB: 'x', kind: 'cognate' });
    expect(wl.all()).toHaveLength(1);
    expect(wl.all()[0]!.kind).toBe('cognate');
  });

  it('removes a wordlink regardless of argument order', () => {
    const wl = new InMemoryWordlinks();
    wl.add({ langA: 'a', conceptA: 'x', langB: 'b', conceptB: 'x', kind: 'cognate' });
    wl.remove('b', 'x', 'a', 'x');
    expect(wl.all()).toHaveLength(0);
  });

  it('byLanguage returns all links involving the given language', () => {
    const wl = new InMemoryWordlinks();
    wl.add({ langA: 'a', conceptA: 'x', langB: 'b', conceptB: 'x', kind: 'cognate' });
    wl.add({ langA: 'a', conceptA: 'y', langB: 'c', conceptB: 'y', kind: 'cognate' });
    wl.add({ langA: 'b', conceptA: 'z', langB: 'c', conceptB: 'z', kind: 'borrowing' });
    expect(wl.byLanguage('a')).toHaveLength(2);
    expect(wl.byLanguage('c')).toHaveLength(2);
    expect(wl.byLanguage('b')).toHaveLength(2);
    expect(wl.byLanguage('zz')).toHaveLength(0);
  });
});

describe('autoCognatesFromDiachrony', () => {
  it('emits one cognate per evolved entry', () => {
    const links = autoCognatesFromDiachrony('proto', 'daughter', [
      { concept: 'mountain', lemma: 'kati', evolved: 'gadi' },
      { concept: 'river',    lemma: 'wala', evolved: 'wal' },
    ]);
    expect(links).toHaveLength(2);
    expect(links[0]!.kind).toBe('cognate');
    expect(links[0]!.note).toContain('kati → gadi');
  });

  it('returns empty when parent == daughter (idempotent)', () => {
    expect(autoCognatesFromDiachrony('proto', 'proto', [
      { concept: 'x', lemma: 'a', evolved: 'b' },
    ])).toEqual([]);
  });
});
