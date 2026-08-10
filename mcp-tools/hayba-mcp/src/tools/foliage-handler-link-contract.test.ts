import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const handler = readFileSync(join(
  here, '..', '..', '..', '..',
  'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit',
  'Private', 'handlers', 'HaybaMCPFoliageHandler.cpp',
), 'utf8');

describe('UE 5.8 foliage link compatibility', () => {
  it('does not directly call the MinimalAPI-only Blueprint AddInstances helper', () => {
    expect(handler).not.toMatch(/AInstancedFoliageActor::AddInstances\s*\(/);
  });

  it('uses the exported IFA + foliage-info append path', () => {
    expect(handler).toMatch(/AInstancedFoliageActor::Get\s*\(/);
    expect(handler).toMatch(/->AddFoliageType\s*\(/);
    expect(handler).toMatch(/Info->AddInstance\s*\(/);
    expect(handler).toMatch(/After != Before \+ 1/);
  });
});
