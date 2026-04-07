import React from 'react';
import type { Project } from '../../types';
import { Breadcrumb } from '../../components/Breadcrumb';

export function ProjectView({ project, onBack }: { project: Project; onBack: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <Breadcrumb segments={[
        { label: 'Projects', onClick: onBack },
        { label: project.name },
      ]} />
      <div style={{ padding: 16, color: 'var(--text-muted)' }}>
        <div style={{ marginBottom: 8, color: 'var(--text-primary)', fontSize: 14 }}>{project.name}</div>
        <div>Status: {project.bakeStatus}</div>
        <div>Created: {new Date(project.createdAt).toLocaleString()}</div>
      </div>
    </div>
  );
}
