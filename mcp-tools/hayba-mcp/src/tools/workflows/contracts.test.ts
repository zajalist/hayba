import { describe, expect, it } from 'vitest';
import { WorldIngestRequestSchema, unsupportedStage } from './contracts.js';

describe('world workflow contracts', () => {
  it('rejects an unknown partition mode', () => {
    expect(() => WorldIngestRequestSchema.parse({
      source: { kind: 'heightmap', path: 'D:/terrain.r16' },
      destination: { mode: 'open_world' },
      partition: { mode: 'automatic' },
    })).toThrow();
  });

  it('represents unsupported separately from skipped', () => {
    expect(unsupportedStage('partition', 'world_partition_unavailable').status)
      .toBe('unsupported');
  });
});
