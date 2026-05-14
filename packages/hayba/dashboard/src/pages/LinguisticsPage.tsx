import React from 'react';

export function LinguisticsPage() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100%', flexDirection: 'column', gap: 16, padding: 24,
      color: '#c8c8c8', background: '#1b1e24',
    }}>
      <h2 style={{ margin: 0 }}>Linguistics moved</h2>
      <p style={{ maxWidth: 480, textAlign: 'center', opacity: 0.85 }}>
        The conlang workbench now lives at <a href="/app" style={{ color: '#B56A1D' }}>hayba.app/app</a>.
      </p>
      <a href="/app" style={{
        background: '#B56A1D', color: '#1a0800', padding: '8px 16px',
        textDecoration: 'none', borderRadius: 4, fontWeight: 600,
      }}>Open workbench →</a>
    </div>
  );
}
