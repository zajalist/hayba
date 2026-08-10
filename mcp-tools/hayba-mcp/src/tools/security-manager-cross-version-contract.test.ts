import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const securityManager = readFileSync(
  join(
    here,
    '..',
    '..',
    '..',
    '..',
    'unreal',
    'HaybaMCPToolkit',
    'Source',
    'HaybaMCPToolkit',
    'Private',
    'HaybaMCPSecurityManager.cpp',
  ),
  'utf8',
);

describe('UE 5.7/5.8 JSON key compatibility', () => {
  it('uses the stable FJsonObject lookup API instead of its version-specific map key type', () => {
    expect(securityManager).not.toMatch(/Values\.FindRef\s*\(\s*UE::FSharedString/);
    expect(securityManager.match(/TryGetField\s*\(\s*Key\s*\)/g)).toHaveLength(2);
  });
});
