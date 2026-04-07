import React, { useEffect, useState } from 'react';
import './TitleBar.css';

interface UEStatus { connected: boolean; }

export function TitleBar({ currentTab, onTabChange }: {
  currentTab: string;
  onTabChange: (tab: string) => void;
}) {
  const [ueStatus, setUeStatus] = useState<UEStatus>({ connected: false });

  useEffect(() => {
    fetch('/api/ue/status').then(r => r.json()).then(d => setUeStatus({ connected: d.connected })).catch(() => {});
    const id = setInterval(() => {
      fetch('/api/ue/status').then(r => r.json()).then(d => setUeStatus({ connected: d.connected })).catch(() => {});
    }, 5000);
    return () => clearInterval(id);
  }, []);

  const tabs = ['Projects', 'PCG', 'Settings'];

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
      </div>
    </div>
  );
}
