import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { schema } from './pie-sightlines.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const cpp = readFileSync(join(here,
  '../../../../../unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPPIEHandler.cpp'), 'utf8');

describe('PIE collision sightlines', () => {
  it('accepts one or more explicit, bounded eye positions and a target', () => {
    expect(schema.safeParse({ eye_positions: [[0, 0, 100], [100, 0, 100]], target_location: [0, 0, 0] }).success).toBe(true);
    expect(schema.safeParse({ eye_positions: [], target_location: [0, 0, 0] }).success).toBe(false);
    expect(schema.safeParse({ eye_positions: Array.from({ length: 33 }, () => [0, 0, 100]), target_location: [0, 0, 0] }).success).toBe(false);
    expect(schema.safeParse({ eye_positions: [[0, 0, 0]], target_location: [0, 0, 0] }).success).toBe(false);
    expect(schema.safeParse({ eye_positions: [[10001, 0, 0]], target_location: [0, 0, 0] }).success).toBe(false);
    expect(schema.safeParse({ eye_positions: [[Infinity, 0, 0]], target_location: [0, 0, 0] }).success).toBe(false);
    expect(schema.safeParse({ eye_positions: [[0, 0, 100]], target_location: [0, 0, 0], stream: true }).success).toBe(false);
  });

  it('uses the selected PIE world for one Visibility trace per sample and reports the first blocker', () => {
    const method = cpp.slice(cpp.indexOf('FHaybaHandlerResult FHaybaMCPPIEHandler::PIESightlines('),
      cpp.indexOf('FHaybaHandlerResult FHaybaMCPPIEHandler::PIEProjectWorld('));
    expect(method).toContain('Worlds.Num() != 1');
    expect(method).toContain('Selected->World->LineTraceSingleByChannel(');
    expect(method).toContain('ECC_Visibility');
    expect(method).toContain('first_blocker');
    expect(method).toContain('static_cast<double>(Tested) / Request.EyePositions.Num()');
    expect(method).not.toContain('Tick(');
  });
});
