import React, { useEffect, useState } from 'react';
import { api } from '../api';
import type { Project } from '../types';
import { ProjectView } from './project/ProjectView';
import './ProjectsPage.css';

export function ProjectsPage({ deepLinkProjectId, deepLinkSection }: { deepLinkProjectId?: string; deepLinkSection?: string }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<Project | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    api.projects.list().then(ps => {
      setProjects(ps);
      if (deepLinkProjectId) {
        const target = ps.find(p => p.id === deepLinkProjectId);
        if (target) setSelected(target);
      }
    });
  }, [deepLinkProjectId]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const p = await api.projects.create(newName.trim());
    setProjects(prev => [p, ...prev]);
    setSelected(p);
    setCreating(false);
    setNewName('');
  };

  if (selected) {
    return <ProjectView project={selected} onBack={() => setSelected(null)} initialSection={deepLinkProjectId === selected.id ? deepLinkSection : undefined} />;
  }

  return (
    <div className="projects-page">
      <div className="projects-header">
        <span className="projects-title uppercase muted">Landscape Projects</span>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>+ New Project</button>
      </div>

      {creating && (
        <div className="projects-create-row">
          <input
            className="input"
            placeholder="Project name..."
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            autoFocus
          />
          <button className="btn btn-primary" onClick={handleCreate}>Create</button>
          <button className="btn btn-ghost" onClick={() => setCreating(false)}>Cancel</button>
        </div>
      )}

      <div className="projects-grid">
        {projects.map(p => (
          <div key={p.id} className="project-card panel">
            <div className="project-card-name">{p.name}</div>
            <div className="project-card-meta muted">{p.bakeStatus} · {new Date(p.lastModified).toLocaleDateString()}</div>
            <div className="project-card-actions">
              <button className="btn btn-primary" onClick={() => setSelected(p)}>Open</button>
            </div>
          </div>
        ))}
        {projects.length === 0 && !creating && (
          <div className="projects-empty muted">No projects yet. Create one to get started.</div>
        )}
      </div>
    </div>
  );
}
