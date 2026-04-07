import React, { useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { ProjectsPage } from './pages/ProjectsPage';
import { PCGPage } from './pages/PCGPage';
import { SettingsPage } from './pages/SettingsPage';

type Tab = 'Projects' | 'PCG' | 'Settings';

export function App() {
  const [tab, setTab] = useState<Tab>('Projects');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <TitleBar currentTab={tab} onTabChange={t => setTab(t as Tab)} />
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {tab === 'Projects' && <ProjectsPage />}
        {tab === 'PCG' && <PCGPage />}
        {tab === 'Settings' && <SettingsPage />}
      </div>
    </div>
  );
}
