import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Lightweight smoke test that the un-parked `hayba_import_landscape` wrapper
 * actually shipped in index.ts (no longer commented out as "schema parked").
 *
 * We deliberately avoid booting registerTools — that would require a full
 * MCP server + UE bridge fake — and instead source-check the registration.
 *
 * Companion runtime test: `routing/meta-tools/invoke.test.ts` covers the
 * UE-legacy dispatch path that this wrapper indirectly exercises.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf-8');

describe('hayba_import_landscape wrapper', () => {
  it('is no longer parked — comment is gone', () => {
    expect(indexSrc).not.toContain('hayba_import_landscape schema parked');
  });

  it('registers a server.tool entry pointing at landscape_import', () => {
    expect(indexSrc).toContain("'hayba_import_landscape'");
    expect(indexSrc).toMatch(/executeCommand\(['"]landscape_import['"]/);
  });

  it('declares the full param schema from the UE Cmd_ImportLandscape signature', () => {
    // Each TryGetStringField / TryGetNumberField call in the C++ handler
    // should have a matching schema entry.
    expect(indexSrc).toMatch(/heightmapPath:\s*z\.string\(\)/);
    expect(indexSrc).toMatch(/worldSizeKm:\s*z\.number\(\)/);
    expect(indexSrc).toMatch(/maxHeightM:\s*z\.number\(\)/);
    expect(indexSrc).toMatch(/actorLabel:\s*z\.string\(\)/);
    expect(indexSrc).toMatch(/landscapeMaterial:\s*z\.string\(\)/);
  });

  it('registers the schema in the eager schema-registry block', () => {
    expect(indexSrc).toMatch(/reg\(\s*['"]hayba_import_landscape['"]/);
  });
});
