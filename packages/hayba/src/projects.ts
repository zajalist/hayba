import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  lastModified: string;
  terrainPath: string | null;
  bakeStatus: 'none' | 'baked' | 'imported';
}

export const DEFAULT_PROJECTS_BASE = join(homedir(), '.hayba', 'projects');

function projectDir(id: string, base = DEFAULT_PROJECTS_BASE): string {
  return join(base, id);
}

export async function createProject(name: string, base = DEFAULT_PROJECTS_BASE): Promise<Project> {
  const id = randomUUID();
  const dir = projectDir(id, base);
  mkdirSync(join(dir, 'masks'), { recursive: true });

  const project: Project = {
    id,
    name,
    createdAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
    terrainPath: null,
    bakeStatus: 'none',
  };

  writeFileSync(join(dir, 'project.json'), JSON.stringify(project, null, 2), 'utf-8');
  writeFileSync(join(dir, 'encyclopedia.json'), '[]', 'utf-8');
  writeFileSync(join(dir, 'zones.json'), 'null', 'utf-8');
  return project;
}

export async function getProject(id: string, base = DEFAULT_PROJECTS_BASE): Promise<Project | null> {
  const file = join(projectDir(id, base), 'project.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf-8')) as Project;
}

export async function updateProject(id: string, patch: Partial<Project>, base = DEFAULT_PROJECTS_BASE): Promise<Project | null> {
  const existing = await getProject(id, base);
  if (!existing) return null;
  const updated = { ...existing, ...patch, lastModified: new Date().toISOString() };
  writeFileSync(join(projectDir(id, base), 'project.json'), JSON.stringify(updated, null, 2), 'utf-8');
  return updated;
}

export async function listProjects(base = DEFAULT_PROJECTS_BASE): Promise<Project[]> {
  if (!existsSync(base)) return [];
  const projects: Project[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = await getProject(entry.name, base);
    if (p) projects.push(p);
  }
  return projects.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
}
