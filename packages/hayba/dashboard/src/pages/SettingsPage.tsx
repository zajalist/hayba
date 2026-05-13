import React, { useEffect, useState } from 'react';

interface SidecarStatus {
  visual_embeddings_available?: boolean;
  active_models?: string[];
  sidecar_url?: string;
  sidecar_error?: string;
  connected?: boolean;
  ueVersion?: string;
  pluginVersion?: string;
}

const cardStyle: React.CSSProperties = {
  background: 'var(--surface-1, #1a1a1a)',
  border: '1px solid var(--border, #333)',
  borderRadius: 6,
  padding: 16,
  marginBottom: 16,
};

const labelStyle: React.CSSProperties = { color: 'var(--text-muted, #888)', fontSize: 12, marginBottom: 4 };
const valueStyle: React.CSSProperties = { color: 'var(--text, #ddd)', fontFamily: 'var(--font-mono, monospace)', fontSize: 13 };

export function SettingsPage() {
  const [status, setStatus] = useState<SidecarStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await fetch('/api/ue/status');
      setStatus(await r.json());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => { load(); }, []);

  const refreshSidecar = async () => {
    setRefreshing(true);
    try {
      await fetch('/api/sidecar/refresh', { method: 'POST' });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const sidecarBadge = status?.sidecar_error
    ? { color: '#e54848', label: 'Offline' }
    : status?.visual_embeddings_available
      ? { color: '#3ad07a', label: 'Online' }
      : { color: '#e8a73c', label: 'Reachable, no models' };

  const ueBadge = status?.connected
    ? { color: '#3ad07a', label: 'Connected' }
    : { color: '#e54848', label: 'Disconnected' };

  return (
    <div style={{ padding: 16, maxWidth: 720 }}>
      <h2 style={{ marginTop: 0 }}>Settings</h2>
      {error && <div style={{ color: '#e54848', marginBottom: 16 }}>{error}</div>}

      <section style={cardStyle}>
        <h3 style={{ margin: '0 0 12px 0' }}>Unreal Engine</h3>
        <div style={labelStyle}>Status</div>
        <div style={valueStyle}>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: ueBadge.color, marginRight: 6 }} />
          {ueBadge.label}
        </div>
        {status?.ueVersion && (
          <>
            <div style={{ ...labelStyle, marginTop: 12 }}>UE version</div>
            <div style={valueStyle}>{status.ueVersion}</div>
          </>
        )}
        {status?.pluginVersion && (
          <>
            <div style={{ ...labelStyle, marginTop: 12 }}>HaybaMCPToolkit plugin</div>
            <div style={valueStyle}>{status.pluginVersion}</div>
          </>
        )}
      </section>

      <section style={cardStyle}>
        <h3 style={{ margin: '0 0 12px 0' }}>Visual Sidecar (CLIP)</h3>
        <div style={labelStyle}>Status</div>
        <div style={valueStyle}>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: sidecarBadge.color, marginRight: 6 }} />
          {sidecarBadge.label}
        </div>

        <div style={{ ...labelStyle, marginTop: 12 }}>Endpoint</div>
        <div style={valueStyle}>{status?.sidecar_url ?? 'unknown'}</div>

        <div style={{ ...labelStyle, marginTop: 12 }}>Active models</div>
        <div style={valueStyle}>{status?.active_models?.length ? status.active_models.join(', ') : '—'}</div>

        {status?.sidecar_error && (
          <>
            <div style={{ ...labelStyle, marginTop: 12 }}>Error</div>
            <div style={{ ...valueStyle, color: '#e54848' }}>{status.sidecar_error}</div>
          </>
        )}

        <button
          onClick={refreshSidecar}
          disabled={refreshing}
          style={{
            marginTop: 16,
            padding: '6px 14px',
            background: 'var(--accent, #3a7af0)',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: refreshing ? 'wait' : 'pointer',
            opacity: refreshing ? 0.6 : 1,
          }}
        >
          {refreshing ? 'Probing…' : 'Re-probe sidecar'}
        </button>
        <p style={{ ...labelStyle, marginTop: 12 }}>
          Start the sidecar with{' '}
          <code style={{ color: 'var(--text, #ddd)' }}>
            uv run --project packages/hayba/addons/visual-embeddings -- uvicorn hayba_sidecar.server:app --port 7821
          </code>
        </p>
      </section>
    </div>
  );
}
