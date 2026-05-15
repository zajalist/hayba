import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { submitZones, getCurrentZones, setHeightmap, getHeightmap } from '../src/zones.js';
import { createProject } from '../src/projects.js';

const TEST_BASE = join(homedir(), '.hayba', 'projects-zones-test-' + Date.now());

const SAMPLE_ZONES = [
  { id: 'z1', name: 'Pine Forest', color: '#3a6e3a', type: 'placement' as const, placementCategory: 'foliage' as const, maskPath: '', visible: true },
  { id: 'z2', name: 'Mountain Ridge', color: '#6e5a2a', type: 'terrain' as const, maskPath: '', visible: true },
];

describe('zones', () => {
  afterEach(() => {
    if (existsSync(TEST_BASE)) rmSync(TEST_BASE, { recursive: true, force: true });
  });

  it('getCurrentZones returns null before any submission', async () => {
    const p = await createProject('Test', TEST_BASE);
    const result = await getCurrentZones(p.id, TEST_BASE);
    expect(result).toBeNull();
  });

  it('submitZones stores session and writes PNG files', async () => {
    const p = await createProject('Test', TEST_BASE);
    const pngBase64 = Buffer.from('fake png data').toString('base64');
    const session = await submitZones(p.id, SAMPLE_ZONES, [
      { zoneId: 'z1', pngBase64 },
      { zoneId: 'z2', pngBase64 },
    ], TEST_BASE);
    expect(session.zones).toHaveLength(2);
    expect(existsSync(session.masks[0].pngPath)).toBe(true);
    expect(existsSync(session.masks[1].pngPath)).toBe(true);
  });

  it('getCurrentZones returns last submitted session', async () => {
    const p = await createProject('Test', TEST_BASE);
    const pngBase64 = Buffer.from('fake png').toString('base64');
    await submitZones(p.id, SAMPLE_ZONES, [{ zoneId: 'z1', pngBase64 }], TEST_BASE);
    const session = await getCurrentZones(p.id, TEST_BASE);
    expect(session?.zones).toHaveLength(2);
  });

  it('setHeightmap and getHeightmap round-trip', async () => {
    const p = await createProject('Test', TEST_BASE);
    await setHeightmap(p.id, '/tmp/terrain.r16', TEST_BASE);
    const result = await getHeightmap(p.id, TEST_BASE);
    expect(result).toBe('/tmp/terrain.r16');
  });

  it('getHeightmap returns null when not set', async () => {
    const p = await createProject('Test', TEST_BASE);
    const result = await getHeightmap(p.id, TEST_BASE);
    expect(result).toBeNull();
  });
});
