import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createScratchSession, submitScratchZones, getScratchZones, cleanupExpiredScratch } from '../src/zones.js';
import { mkdirSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';

const TEST_BASE = path.join(os.tmpdir(), 'hayba-scratch-test-' + process.pid);

beforeEach(() => {
  mkdirSync(TEST_BASE, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_BASE, { recursive: true, force: true });
});

describe('scratch sessions', () => {
  it('creates a scratch session with a unique ID', () => {
    const session = createScratchSession(TEST_BASE);
    expect(session.scratchSessionId).toBeDefined();
    expect(typeof session.scratchSessionId).toBe('string');
    expect(session.scratchSessionId.length).toBeGreaterThan(0);
  });

  it('two scratch sessions have different IDs', () => {
    const a = createScratchSession(TEST_BASE);
    const b = createScratchSession(TEST_BASE);
    expect(a.scratchSessionId).not.toBe(b.scratchSessionId);
  });

  it('stores and retrieves zone data', async () => {
    const session = createScratchSession(TEST_BASE);
    const zones = [
      { id: 'z1', name: 'Mountain', description: 'Peak zone', color: '#ff0000', type: 'terrain' as const, visible: true },
    ];
    const masks = [{ zoneId: 'z1', pngBase64: 'iVBORw0KGgo=' }];

    await submitScratchZones(session.scratchSessionId, zones, masks, TEST_BASE);
    const retrieved = await getScratchZones(session.scratchSessionId, TEST_BASE);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.zones).toHaveLength(1);
    expect(retrieved!.zones[0].name).toBe('Mountain');
    expect(retrieved!.projectId).toBe(`scratch:${session.scratchSessionId}`);
  });

  it('returns null for unknown scratch session', async () => {
    const result = await getScratchZones('nonexistent-id', TEST_BASE);
    expect(result).toBeNull();
  });

  it('cleans up expired sessions', async () => {
    const session = createScratchSession(TEST_BASE, -1); // already expired
    await submitScratchZones(
      session.scratchSessionId,
      [{ id: 'z1', name: 'test', description: '', color: '#fff', type: 'terrain' as const, visible: true }],
      [],
      TEST_BASE,
    );

    cleanupExpiredScratch(TEST_BASE);
    const retrieved = await getScratchZones(session.scratchSessionId, TEST_BASE);
    expect(retrieved).toBeNull();
  });

  it('does not clean up non-expired sessions', async () => {
    const session = createScratchSession(TEST_BASE, 24 * 60 * 60 * 1000); // 24h
    await submitScratchZones(
      session.scratchSessionId,
      [{ id: 'z1', name: 'valid', description: '', color: '#000', type: 'terrain' as const, visible: true }],
      [],
      TEST_BASE,
    );

    cleanupExpiredScratch(TEST_BASE);
    const retrieved = await getScratchZones(session.scratchSessionId, TEST_BASE);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.zones[0].name).toBe('valid');
  });
});
