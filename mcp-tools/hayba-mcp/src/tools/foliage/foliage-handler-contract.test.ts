import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const handler = readFileSync(join(
  root, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit',
  'Private', 'handlers', 'HaybaMCPFoliageHandler.cpp',
), 'utf8');

describe('partition-safe foliage handler contract', () => {
  it('never asks the actor-partition subsystem for an IFA without a level hint', () => {
    // UE 5.8 asserts InLevelHint in ActorPartitionSubsystem.cpp:184. This exact
    // spelling survived SEH but poisoned the session during foliage_list_types.
    expect(handler).not.toMatch(/AInstancedFoliageActor::Get\(World,\s*(?:true|false)\s*\)/);
  });

  it('enumerates loaded partition actors for read/remove operations', () => {
    expect(handler).toContain('TActorIterator<AInstancedFoliageActor>');
  });

  it('uses the engine-supported persistence path for add and paint', () => {
    expect(handler.match(/AInstancedFoliageActor::AddInstances/g)?.length).toBe(2);
    expect(handler).not.toContain('foliage instance persistence is unavailable');
  });

  it('accepts the object vector spelling published by the TypeScript schemas', () => {
    expect(handler).toContain('TryGetObjectField(Field, VectorObj)');
    expect(handler).toContain('TryGetNumberField(TEXT("x"), X)');
    expect(handler).toContain('IsFiniteVector');
  });

  it('bounds the paint workload before allocating or tracing', () => {
    expect(handler).toContain('Density > 10000');
    expect(handler).toContain('Radius > 1000000.0');
    expect(handler.indexOf('Density > 10000')).toBeLessThan(handler.indexOf('Transforms.Reserve(Density)'));
  });
});
