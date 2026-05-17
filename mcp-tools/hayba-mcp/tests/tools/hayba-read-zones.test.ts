import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readZonesHandler } from '../../src/tools/hayba-read-zones.js';
import { createProject } from '../../src/projects.js';
import { submitZones } from '../../src/zones.js';

const TEST_BASE = join(homedir(), '.hayba', 'projects-rz-test-' + Date.now());

describe('hayba_read_zones', () => {
  afterEach(() => {
    if (existsSync(TEST_BASE)) rmSync(TEST_BASE, { recursive: true, force: true });
  });

  it('returns error when no submission exists', async () => {
    const p = await createProject('Test', TEST_BASE);
    const result = await readZonesHandler({ projectId: p.id }, TEST_BASE);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No zone submission');
  });

  it('returns zone session after submission', async () => {
    const p = await createProject('Test', TEST_BASE);
    await submitZones(p.id, [
      { id: 'z1', name: 'Forest', color: '#3a6', type: 'placement', placementCategory: 'foliage', visible: true },
    ], [{ zoneId: 'z1', pngBase64: Buffer.from('x').toString('base64') }], TEST_BASE);

    const result = await readZonesHandler({ projectId: p.id }, TEST_BASE);
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.zones).toHaveLength(1);
    expect(data.zones[0].name).toBe('Forest');
  });

  it('returns error when projectId is missing', async () => {
    const result = await readZonesHandler({}, TEST_BASE);
    expect(result.isError).toBe(true);
  });
});
