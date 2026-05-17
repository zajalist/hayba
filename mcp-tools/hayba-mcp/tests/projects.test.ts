import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createProject, getProject, listProjects } from '../src/projects.js';

const TEST_BASE = join(homedir(), '.hayba', 'projects-test-' + Date.now());

describe('projects', () => {
  afterEach(() => {
    if (existsSync(TEST_BASE)) rmSync(TEST_BASE, { recursive: true, force: true });
  });

  it('createProject creates directory and project.json', async () => {
    const p = await createProject('Alpine Meadow', TEST_BASE);
    expect(p.name).toBe('Alpine Meadow');
    expect(typeof p.id).toBe('string');
    expect(existsSync(join(TEST_BASE, p.id, 'project.json'))).toBe(true);
    expect(existsSync(join(TEST_BASE, p.id, 'masks'))).toBe(true);
  });

  it('getProject returns null for unknown id', async () => {
    const p = await getProject('nonexistent', TEST_BASE);
    expect(p).toBeNull();
  });

  it('getProject returns project after create', async () => {
    const created = await createProject('Desert Canyons', TEST_BASE);
    const fetched = await getProject(created.id, TEST_BASE);
    expect(fetched?.name).toBe('Desert Canyons');
  });

  it('listProjects returns all created projects', async () => {
    await createProject('A', TEST_BASE);
    await createProject('B', TEST_BASE);
    const list = await listProjects(TEST_BASE);
    expect(list.length).toBeGreaterThanOrEqual(2);
  });
});
