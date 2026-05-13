import React, { useEffect, useState } from 'react';
import './TitleBar.css';

interface UEStatus {
  connected: boolean;
  visual_embeddings_available?: boolean;
  active_models?: string[];
  sidecar_url?: string;
  sidecar_error?: string;
}

export function TitleBar({ currentTab, onTabChange }: {
  currentTab: string;
  onTabChange: (tab: string) => void;
}) {
  const [ueStatus, setUeStatus] = useState<UEStatus>({ connected: false });

  useEffect(() => {
    const refresh = () => {
      fetch('/api/ue/status').then(r => r.json()).then(setUeStatus).catch(() => {});
    };
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  const tabs = ['Projects', 'PCG', 'Linguistics', 'Settings'];

  // Sidecar badge: 🟢 active models present, 🔴 unreachable / errored, 🟡 reachable but no models active.
  const sidecarDot = ueStatus.sidecar_error
    ? 'dot-red'
    : ueStatus.visual_embeddings_available
      ? 'dot-green'
      : 'dot-orange';
  const sidecarTitle = ueStatus.sidecar_error
    ? `Visual sidecar unavailable: ${ueStatus.sidecar_error}`
    : ueStatus.visual_embeddings_available
      ? `Visual sidecar online — ${(ueStatus.active_models ?? []).join(', ')}`
      : 'Visual sidecar reachable but no models active';

  return (
    <div className="titlebar">
      <span className="titlebar-logo">HAYBA</span>
      <div className="titlebar-tabs">
        {tabs.map(tab => (
          <button
            key={tab}
            className={`titlebar-tab ${currentTab === tab ? 'active' : ''}`}
            onClick={() => onTabChange(tab)}
          >
            {tab}
          </button>
        ))}
      </div>
      <div className="titlebar-status">
        <span><span className={`dot ${ueStatus.connected ? 'dot-green' : 'dot-red'}`} /> UE 5.7</span>
        <span><span className="dot dot-orange" /> Gaea</span>
        <span title={sidecarTitle}><span className={`dot ${sidecarDot}`} /> CLIP</span>
      </div>
    </div>
  );
}
