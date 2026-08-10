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
    //
    // Whitespace is permitted between `z` and its type because these are
    // source-text assertions and the formatter is free to break a long zod
    // chain across lines. It did exactly that to maxHeightM, and this suite went
    // permanently red over a line break rather than a real regression — a
    // failing check nobody can act on trains everyone to ignore the suite.
    const declares = (param: string, zodType: 'string' | 'number'): RegExp =>
      new RegExp(`${param}:\\s*z\\s*\\.\\s*${zodType}\\(\\)`);

    expect(indexSrc).toMatch(declares('heightmapPath', 'string'));
    expect(indexSrc).toMatch(declares('worldSizeKm', 'number'));
    expect(indexSrc).toMatch(declares('maxHeightM', 'number'));
    expect(indexSrc).toMatch(declares('actorLabel', 'string'));
    expect(indexSrc).toMatch(declares('landscapeMaterial', 'string'));
  });

  it('feeds its descriptor through the shared schema-seeding loop', () => {
    expect(indexSrc).toMatch(/name:\s*['"]hayba_import_landscape['"]/);
    expect(indexSrc).toMatch(
      /for\s*\(\s*const\s+descriptor\s+of\s+STATIC_TOOL_CATALOGUE\s*\)\s*recordToolSchema\(/,
    );
  });
});
