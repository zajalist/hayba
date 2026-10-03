import { describe, expect, it } from 'vitest';
import { inferDir, STANDARD_DESCRIPTORS } from '../index.js';
import { deriveDomainPacks } from '../routing/pack-discovery.js';

describe('World tool deferred routing', () => {
  it('keeps capture and snapshot queries in the same World domain pack', () => {
    const names = ['world_tile_capture', 'world_semantic_snapshot'];
    for (const name of names) {
      expect(STANDARD_DESCRIPTORS.some((descriptor) => descriptor.name === name)).toBe(true);
      expect(inferDir(name)).toBe('world');
    }
    const packs = deriveDomainPacks(new Map(names.map((name) => [name, inferDir(name)])), new Map());
    expect(packs.find((pack) => pack.name === 'world')?.tools).toEqual(names.slice().sort());
  });

  it('describes position-based capture and capture-ID-pinned reads at discovery', () => {
    const capture = STANDARD_DESCRIPTORS.find((descriptor) => descriptor.name === 'world_tile_capture');
    const snapshot = STANDARD_DESCRIPTORS.find((descriptor) => descriptor.name === 'world_semantic_snapshot');
    expect(capture?.description).toContain('position_cm');
    expect(capture?.description).toContain('capture_id');
    expect(capture?.description).toContain('first overview');
    expect(snapshot?.description).toContain('relations');
    expect(snapshot?.description).toContain('expected_capture_id');
  });
});
