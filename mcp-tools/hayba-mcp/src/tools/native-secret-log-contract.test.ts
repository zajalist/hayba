import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const build = read(
  'unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPBuildHandler.cpp',
);
const redactionHeader = read(
  'unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPSecretRedaction.h',
);
const redactionTest = read(
  'unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Tests/HaybaMCPSecretRedactionTest.cpp',
);

describe('native log secret boundary (#383)', () => {
  it('redacts process paths, parameters, and stdout before UE_LOG', () => {
    expect(redactionHeader).toContain('FString RedactTextForLog(');
    expect(build).toContain('RedactTextForLog(URL, 2048)');
    expect(build).toContain('RedactTextForLog(Params, 4096)');
    expect(build).toContain('RedactTextForLog(Short, 1024)');
    expect(build).not.toMatch(/UE_LOG\([^;]*\*URL\s*,\s*\*Params\)/s);
    expect(build).not.toMatch(/UE_LOG\([^;]*\*Short\)/s);
  });

  it('has a native secret sentinel and hard output-bound regression', () => {
    expect(redactionTest).toContain('SENTINEL_NATIVE_LOG_SECRET');
    expect(redactionTest).toContain('native log text drops bearer secrets');
    expect(redactionTest).toContain('native log text is bounded');
  });
});
