import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Smoke test for the asset-domain wrapper tools:
 * - asset_delete
 * - asset_move
 * - asset_rename
 *
 * Tests that each wrapper is:
 * 1. Registered in index.ts with server.tool()
 * 2. Wired to executeCommand() with the correct command name (in handler files)
 * 3. Registered in the eager schema-registry block via reg()
 * 4. Has the correct schema fields
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(__dirname, '..', 'index.ts'), 'utf-8');

const assetDeleteSrc = readFileSync(join(__dirname, 'asset-delete.ts'), 'utf-8');
const assetMoveSrc = readFileSync(join(__dirname, 'asset-move.ts'), 'utf-8');
const assetRenameSrc = readFileSync(join(__dirname, 'asset-rename.ts'), 'utf-8');

describe('asset-domain wrappers', () => {
  describe('asset_delete', () => {
    it('has a server.tool registration', () => {
      expect(indexSrc).toMatch(/server\.tool\(\s*['"]asset_delete['"]/);
    });
    it('calls executeCommand with the correct command name in handler', () => {
      expect(assetDeleteSrc).toMatch(/executeCommand\(\s*['"]asset_delete['"]/);
    });
    it('registers the schema in the eager schema-registry block', () => {
      expect(indexSrc).toMatch(/reg\(\s*['"]asset_delete['"]/);
    });
    it('has a path schema field', () => {
      expect(assetDeleteSrc).toMatch(/path:\s*z\.string\(\)\.min\(1\)/);
    });
  });

  describe('asset_move', () => {
    it('has a server.tool registration', () => {
      expect(indexSrc).toMatch(/server\.tool\(\s*['"]asset_move['"]/);
    });
    it('calls executeCommand with the correct command name in handler', () => {
      expect(assetMoveSrc).toMatch(/executeCommand\(\s*['"]asset_move['"]/);
    });
    it('registers the schema in the eager schema-registry block', () => {
      expect(indexSrc).toMatch(/reg\(\s*['"]asset_move['"]/);
    });
    it('has path and target_dir schema fields', () => {
      expect(assetMoveSrc).toMatch(/path:\s*z\.string\(\)\.min\(1\)/);
      expect(assetMoveSrc).toMatch(/target_dir:\s*z\.string\(\)\.min\(1\)/);
    });
  });

  describe('asset_rename', () => {
    it('has a server.tool registration', () => {
      expect(indexSrc).toMatch(/server\.tool\(\s*['"]asset_rename['"]/);
    });
    it('calls executeCommand with the correct command name in handler', () => {
      expect(assetRenameSrc).toMatch(/executeCommand\(\s*['"]asset_rename['"]/);
    });
    it('registers the schema in the eager schema-registry block', () => {
      expect(indexSrc).toMatch(/reg\(\s*['"]asset_rename['"]/);
    });
    it('has path and new_name schema fields', () => {
      expect(assetRenameSrc).toMatch(/path:\s*z\.string\(\)\.min\(1\)/);
      expect(assetRenameSrc).toMatch(/new_name:\s*z\.string\(\)\.min\(1\)/);
    });
  });
});
