import React, { useMemo, useState } from 'react';
import { CARDINAL_VOWELS, PULMONIC_CONSONANTS } from '../../../../../packages/linguistics/src/ipa-chart';

/**
 * L1 — clickable IPA palette for assembling phoneme inventories before MCP persistence.
 * Selection state is local-only (production hooks store via language_define_phonology).
 */
export function LinguisticsPage() {
  const [picked, setPicked] = useState<string[]>([]);

  const tokens = useMemo(() => picked.join(''), [picked]);

  return (
    <div style={{ padding: '1rem 1.5rem', overflow: 'auto', height: '100%', color: '#dce7ef', background: '#0e141b' }}>
      <h2 style={{ marginTop: 0, fontWeight: 600, letterSpacing: '0.02em' }}>Phonology lab</h2>
      <p style={{ maxWidth: '52rem', lineHeight: 1.5, opacity: 0.85 }}>
        Tap symbols to build an inventory string. Copy into{' '}
        <code style={{ color: '#8ecae6' }}>language_define_phonology</code> JSON (<code>phoneme.symbol</code> fields).
      </p>

      <section style={{ marginBottom: '1.25rem' }}>
        <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.65 }}>Inventory</div>
        <div
          style={{
            marginTop: '0.35rem',
            padding: '0.65rem 0.85rem',
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.12)',
            fontFamily: 'Consolas, monospace',
            fontSize: '1.15rem',
            minHeight: '2.5rem',
          }}
        >
          {tokens || '—'}
        </div>
        <button
          type="button"
          onClick={() => setPicked([])}
          style={{
            marginTop: '0.5rem',
            padding: '0.35rem 0.75rem',
            borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.15)',
            background: 'rgba(255,255,255,0.06)',
            color: '#dce7ef',
            cursor: 'pointer',
          }}
        >
          Clear
        </button>
      </section>

      <section style={{ marginBottom: '1.5rem' }}>
        <h3 style={{ fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.7 }}>Pulmonic consonants</h3>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(2.25rem, 1fr))',
            gap: '0.35rem',
            maxWidth: '48rem',
            marginTop: '0.5rem',
          }}
        >
          {PULMONIC_CONSONANTS.map(c => (
            <button
              key={c.symbol}
              type="button"
              title={`${c.ipa} — ${c.voicing} ${c.manner}, ${c.place}`}
              onClick={() => setPicked(p => [...p, c.symbol])}
              style={{
                padding: '0.4rem 0',
                borderRadius: 6,
                border: '1px solid rgba(255,255,255,0.1)',
                background: 'rgba(30,58,95,0.35)',
                color: '#f8fafc',
                fontSize: '1.05rem',
                cursor: 'pointer',
              }}
            >
              {c.symbol}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3 style={{ fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.7 }}>Cardinal vowels</h3>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(2.25rem, 1fr))',
            gap: '0.35rem',
            maxWidth: '36rem',
            marginTop: '0.5rem',
          }}
        >
          {CARDINAL_VOWELS.map(v => (
            <button
              key={v.symbol}
              type="button"
              title={`${v.ipa} — ${v.height} ${v.backness}`}
              onClick={() => setPicked(p => [...p, v.symbol])}
              style={{
                padding: '0.4rem 0',
                borderRadius: 6,
                border: '1px solid rgba(255,255,255,0.1)',
                background: 'rgba(42,74,52,0.45)',
                color: '#f8fafc',
                fontSize: '1.05rem',
                cursor: 'pointer',
              }}
            >
              {v.symbol}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
