import React, { useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { ProjectsPage } from './pages/ProjectsPage';
import { PCGPage } from './pages/PCGPage';
import { SettingsPage } from './pages/SettingsPage';

type Tab = 'Projects' | 'PCG' | 'Settings';

// Parse deep-link from hash: #project/{id}/zones or #project/{id}
function parseHash(): { projectId?: string; section?: string } {
  const hash = window.location.hash.replace('#', '');
  const parts = hash.split('/');
  if (parts[0] === 'project' && parts[1]) {
    return { projectId: parts[1], section: parts[2] ?? 'zones' };
  }
  return {};
}

export function App() {
  const [tab, setTab] = useState<Tab>('Projects');
  const [deepLink] = useState(parseHash);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <TitleBar currentTab={tab} onTabChange={t => setTab(t as Tab)} />
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {tab === 'Projects' && <ProjectsPage deepLinkProjectId={deepLink.projectId} deepLinkSection={deepLink.section} />}
        {tab === 'PCG' && <PCGPage />}
        {tab === 'Settings' && <SettingsPage />}
      </div>
    </div>
  );
}
