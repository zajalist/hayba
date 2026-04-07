import React from 'react';

export function Breadcrumb({ segments }: { segments: { label: string; onClick?: () => void }[] }) {
  return (
    <div style={{
      height: 24,
      background: '#131313',
      borderBottom: '1px solid #1e1e1e',
      display: 'flex',
      alignItems: 'center',
      padding: '0 12px',
      gap: 6,
      flexShrink: 0,
    }}>
      {segments.map((seg, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span style={{ color: '#333', fontSize: 9 }}>›</span>}
          <span
            style={{
              color: i === segments.length - 1 ? 'var(--accent)' : 'var(--text-muted)',
              fontSize: 10,
              cursor: seg.onClick ? 'pointer' : 'default',
            }}
            onClick={seg.onClick}
          >
            {seg.label}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}
