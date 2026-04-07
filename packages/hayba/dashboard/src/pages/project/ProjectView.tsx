import React, { useState } from 'react';
import type { Project } from '../../types';
import { Breadcrumb } from '../../components/Breadcrumb';
import { ZonePainter } from './ZonePainter';
import { EncyclopediaView } from './EncyclopediaView';

type Section = 'Overview' | 'Zone Painter' | 'Encyclopedia';

function resolveSection(s?: string): Section {
  if (s === 'zones') return 'Zone Painter';
  if (s === 'encyclopedia') return 'Encyclopedia';
  return 'Overview';
}

export function ProjectView({ project, onBack, initialSection }: { project: Project; onBack: () => void; initialSection?: string }) {
  const [section, setSection] = useState<Section>(resolveSection(initialSection));

  const crumbs = [
    { label: 'Projects', onClick: onBack },
    { label: project.name, onClick: () => setSection('Overview') },
    { label: section },
  ];

  const navItems: Section[] = ['Overview', 'Zone Painter', 'Encyclopedia'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <Breadcrumb segments={crumbs} />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Left sub-nav */}
        <div style={{ width: 140, background: '#131313', borderRight: '1px solid #1e1e1e', padding: '8px 0', flexShrink: 0 }}>
          {navItems.map(item => (
            <div
              key={item}
              onClick={() => setSection(item)}
              style={{
                padding: '7px 14px',
                fontSize: 10,
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                cursor: 'pointer',
                color: section === item ? 'var(--accent)' : 'var(--text-muted)',
                background: section === item ? 'var(--accent-dim)' : 'transparent',
                borderLeft: section === item ? '2px solid var(--accent)' : '2px solid transparent',
              }}
            >
              {item}
            </div>
          ))}
        </div>
        {/* Content */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {section === 'Overview' && (
            <div style={{ padding: 16, color: 'var(--text-muted)' }}>
              <div style={{ marginBottom: 8, color: 'var(--text-primary)', fontSize: 14 }}>{project.name}</div>
              <div>Status: {project.bakeStatus}</div>
              <div>Created: {new Date(project.createdAt).toLocaleString()}</div>
            </div>
          )}
          {section === 'Zone Painter' && <ZonePainter project={project} />}
          {section === 'Encyclopedia' && <EncyclopediaView project={project} />}
        </div>
      </div>
    </div>
  );
}
