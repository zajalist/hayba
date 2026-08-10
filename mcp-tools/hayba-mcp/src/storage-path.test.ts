import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  StorageIdentifierError,
  requireStorageFileStem,
  requireStorageUuid,
  resolveStorageChild,
} from './storage-path.js';
import { submitScratchZones, submitZones } from './zones.js';

const tempDirs = new Set<string>();

function tempBase(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hayba-storage-boundary-'));
  tempDirs.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

describe('storage path boundary', () => {
  it('accepts generated UUIDs and resolves a strict child', () => {
    const base = tempBase();
    const id = randomUUID();
    expect(requireStorageUuid(id, 'projectId')).toBe(id);
    expect(resolveStorageChild(base, id, 'project.json')).toBe(resolve(base, id, 'project.json'));
  });

  it.each([
    '../../outside',
    '..\\..\\outside',
    '00000000-0000-0000-0000-000000000000',
    '6ba7b810-9dad-01d1-80b4-00c04fd430c8/extra',
    '',
    ['6ba7b810-9dad-41d1-80b4-00c04fd430c8'],
    { toString: () => '6ba7b810-9dad-41d1-80b4-00c04fd430c8' },
  ])('rejects a non-UUID storage directory: %s', (value) => {
    expect(() => requireStorageUuid(value, 'projectId')).toThrow(StorageIdentifierError);
  });

  it.each(['../escape', '..\\escape', '.', '..', 'a/b', 'a:b', 'CON', 'lpt9', '', 'a'.repeat(129)])(
    'rejects a non-portable filename stem: %s',
    (value) => {
      expect(() => requireStorageFileStem(value, 'zoneId')).toThrow(StorageIdentifierError);
    },
  );

  it('rejects roots, parents, absolute escapes, and traversal segments', () => {
    const base = tempBase();
    for (const segments of [[], ['..'], ['..', 'outside'], [resolve(base, '..', 'outside')]]) {
      expect(() => resolveStorageChild(base, ...segments)).toThrow(StorageIdentifierError);
    }
  });

  it('rejects every invalid project/mask name before creating anything', async () => {
    const base = tempBase();
    const validProjectId = randomUUID();

    await expect(submitZones('../../outside', [], [], base)).rejects.toBeInstanceOf(StorageIdentifierError);
    await expect(
      submitZones(validProjectId, [], [{ zoneId: '../outside', pngBase64: '' }], base),
    ).rejects.toBeInstanceOf(StorageIdentifierError);

    expect(readdirSync(base)).toEqual([]);
    expect(existsSync(join(base, validProjectId))).toBe(false);
  });

  it('rejects invalid scratch identifiers and masks before creating anything', async () => {
    const base = tempBase();
    const validScratchId = randomUUID();

    await expect(submitScratchZones('../outside', [], [], base)).rejects.toBeInstanceOf(StorageIdentifierError);
    await expect(
      submitScratchZones(validScratchId, [], [{ zoneId: 'NUL', pngBase64: '' }], base),
    ).rejects.toBeInstanceOf(StorageIdentifierError);

    expect(readdirSync(base)).toEqual([]);
  });
});
