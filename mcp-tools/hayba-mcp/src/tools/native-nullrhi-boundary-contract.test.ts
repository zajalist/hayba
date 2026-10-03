import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const command = read('unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCommandHandler.cpp');
const advisoryTest = read('unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Tests/HaybaMCPAdvisoryBoundaryTest.cpp');
const params = read('unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Public/HaybaMCPParams.h');
const paramsTest = read('unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Tests/HaybaMCPParamsTest.cpp');
const renderTest = read('unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Tests/HaybaMCPRenderSafetyTest.cpp');
const actorHandler = read('unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPActorHandler.cpp');

/** Text from `start` to the first `end` after it; fails closed when absent. */
function bodyBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `${start} not found`).toBeGreaterThan(-1);
  const to = source.indexOf(end, from);
  expect(to, `${start} is unterminated`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('native regressions observed in a UE NullRHI run', () => {
  it('exercises advisory shaping with the registered destructive actor command', () => {
    // The actor handler registers actor_transform; actor_set_transform is not
    // a command, so an advisory probe under that name tests nothing real.
    const registered = bodyBetween(actorHandler, 'FHaybaMCPActorHandler::GetCommands()', '};');
    const gated = bodyBetween(command, 'static const TSet<FString> DestructiveCommands', '};');
    expect(registered).toContain('TEXT("actor_transform")');
    expect(gated).toContain('TEXT("actor_transform")');
    expect(advisoryTest).toMatch(
      /MakeOkResponse\(\s*TEXT\("2c"\),\s*MakeShared<FJsonObject>\(\),\s*TEXT\("actor_transform"\)\)/,
    );
    expect(advisoryTest).not.toContain('TEXT("actor_set_transform")');
  });

  it('checks JSON kinds before Unreal scalar accessors can coerce them', () => {
    expect(params.match(/HasJsonKind\(Key, EJson::String\)/g)).toHaveLength(2);
    expect(params.match(/HasJsonKind\(Key, EJson::Boolean\)/g)).toHaveLength(1);
    expect(paramsTest).toContain('wrong required string is rejected');
  });

  it('accepts either truthful pre-allocation NullRHI refusal path', () => {
    expect(renderTest).toContain('LeaseError.Contains(TEXT("without render capability"))');
    expect(renderTest).toContain('LeaseError.Contains(TEXT("real initialized RHI"))');
  });
});
