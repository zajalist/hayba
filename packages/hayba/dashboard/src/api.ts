import type { Project, ZoneSession, EncyclopediaEntry, Zone } from './types';

const BASE = '/api';

export const api = {
  projects: {
    list: (): Promise<Project[]> =>
      fetch(`${BASE}/projects`).then(r => r.json()),
    get: (id: string): Promise<Project> =>
      fetch(`${BASE}/projects/${id}`).then(r => r.json()),
    create: (name: string): Promise<Project> =>
      fetch(`${BASE}/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).then(r => r.json()),
  },
  zones: {
    getCurrent: (projectId: string): Promise<ZoneSession | null> =>
      fetch(`${BASE}/zones/current/${projectId}`).then(r => r.ok ? r.json() : null),
    submit: (body: { projectId: string; zones: Zone[]; masks: { zoneId: string; pngBase64: string }[]; canvasSize?: number; phase?: string }) =>
      fetch(`${BASE}/zones/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()),
    getHeightmap: (projectId: string): Promise<{ heightmapPath: string | null }> =>
      fetch(`${BASE}/zones/heightmap/${projectId}`).then(r => r.json()),
  },
  encyclopedia: {
    getEntries: (projectId: string): Promise<EncyclopediaEntry[]> =>
      fetch(`${BASE}/encyclopedia/${projectId}`).then(r => r.json()),
    addEntry: (projectId: string, entry: EncyclopediaEntry) =>
      fetch(`${BASE}/encyclopedia/${projectId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) }).then(r => r.json()),
    deleteEntry: (projectId: string, entryId: string) =>
      fetch(`${BASE}/encyclopedia/${projectId}/${entryId}`, { method: 'DELETE' }).then(r => r.json()),
    getTemplates: (): Promise<EncyclopediaEntry[]> =>
      fetch(`${BASE}/encyclopedia/templates`).then(r => r.json()),
  },
};
