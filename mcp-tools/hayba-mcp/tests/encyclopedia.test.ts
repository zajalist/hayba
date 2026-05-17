import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getEntries, addEntry, deleteEntry, getBaseTemplates } from '../src/encyclopedia.js';
import { createProject } from '../src/projects.js';

const TEST_BASE = join(homedir(), '.hayba', 'projects-enc-test-' + Date.now());

describe('encyclopedia', () => {
  afterEach(() => {
    if (existsSync(TEST_BASE)) rmSync(TEST_BASE, { recursive: true, force: true });
  });

  it('getEntries returns empty array for new project', async () => {
    const p = await createProject('Test', TEST_BASE);
    const entries = await getEntries(p.id, TEST_BASE);
    expect(entries).toEqual([]);
  });

  it('addEntry persists and getEntries returns it', async () => {
    const p = await createProject('Test', TEST_BASE);
    await addEntry(p.id, {
      id: 'e1',
      name: 'Scots Pine',
      type: 'foliage',
      region: ['Boreal'],
      ueMeshPath: '',
      attributes: { densityPerM2: 0.4 },
      isBaseEntry: false,
    }, TEST_BASE);
    const entries = await getEntries(p.id, TEST_BASE);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('Scots Pine');
  });

  it('addEntry updates existing entry with same id', async () => {
    const p = await createProject('Test', TEST_BASE);
    await addEntry(p.id, { id: 'e1', name: 'Pine', type: 'foliage', region: [], ueMeshPath: '', attributes: {}, isBaseEntry: false }, TEST_BASE);
    await addEntry(p.id, { id: 'e1', name: 'Updated Pine', type: 'foliage', region: [], ueMeshPath: '', attributes: {}, isBaseEntry: false }, TEST_BASE);
    const entries = await getEntries(p.id, TEST_BASE);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('Updated Pine');
  });

  it('deleteEntry removes entry', async () => {
    const p = await createProject('Test', TEST_BASE);
    await addEntry(p.id, { id: 'e1', name: 'Pine', type: 'foliage', region: [], ueMeshPath: '', attributes: {}, isBaseEntry: false }, TEST_BASE);
    await deleteEntry(p.id, 'e1', TEST_BASE);
    const entries = await getEntries(p.id, TEST_BASE);
    expect(entries).toHaveLength(0);
  });

  it('getBaseTemplates returns non-empty array', () => {
    const templates = getBaseTemplates();
    expect(templates.length).toBeGreaterThan(0);
    expect(templates[0]).toHaveProperty('name');
    expect(templates[0]).toHaveProperty('type');
    expect(templates[0].isBaseEntry).toBe(true);
  });
});
