import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildUeHeaderIndex, type UeHeaderIndex } from './ue-header-index.js';
import {
  loadUeHeaderDatabase,
  publishUeHeaderDatabase,
  rebuildUeHeaderDatabase,
  UE_HEADER_DATABASE_APPLICATION_ID,
  UE_HEADER_DATABASE_SCHEMA_VERSION,
} from './ue-header-database.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function sandbox(): Promise<{ root: string; source: string; output: string }> {
  const root = await mkdtemp(join(tmpdir(), 'hayba-ue-db-'));
  sandboxes.push(root);
  const source = join(root, 'Engine', 'Source');
  const output = join(root, 'output');
  await Promise.all([mkdir(source, { recursive: true }), mkdir(output, { recursive: true })]);
  return { root, source, output };
}

async function writeFixture(source: string, second = false): Promise<void> {
  const publicDir = join(source, 'Runtime', 'Engine', 'Public');
  await mkdir(publicDir, { recursive: true });
  await writeFile(
    join(publicDir, 'ActorIterator.h'),
    `/** Iterates actors without allocating an array. */\n` + `class FActorIterator { public: void Iterate(); };\n`,
    'utf8',
  );
  if (second) {
    await writeFile(
      join(publicDir, 'OldIterator.h'),
      `/** @deprecated Use FActorIterator. */\n` + `UE_DEPRECATED(5.7, "Use FActorIterator") class FOldIterator {};\n`,
      'utf8',
    );
  }
}

async function fixtureIndex(source: string, second = false): Promise<UeHeaderIndex> {
  await writeFixture(source, second);
  return buildUeHeaderIndex({ sourceRoot: source, engineVersion: '5.7.0' });
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('UE header SQLite persistence', () => {
  it('publishes deterministic SQLite bytes and reloads the complete portable index', async () => {
    const { source, output } = await sandbox();
    await writeFixture(source, true);
    const options = {
      sourceRoot: source,
      outputRoot: output,
      databaseFileName: 'ue-5.7.sqlite',
      engineVersion: '5.7.0',
    };

    const first = await rebuildUeHeaderDatabase(options);
    const firstBytes = await readFile(join(output, 'ue-5.7.sqlite'));
    const loaded = await loadUeHeaderDatabase(options);
    const second = await rebuildUeHeaderDatabase(options);
    const secondBytes = await readFile(join(output, 'ue-5.7.sqlite'));

    expect(first).toMatchObject({
      database_file: 'ue-5.7.sqlite',
      database_schema_version: UE_HEADER_DATABASE_SCHEMA_VERSION,
      index_schema_version: 1,
      symbols_written: 3,
      replaced_existing: false,
      atomic_publish: true,
      sqlite_synchronous: 'FULL',
      file_sync: 'completed',
    });
    expect(second.replaced_existing).toBe(true);
    expect(second.fingerprint_sha256).toBe(first.fingerprint_sha256);
    expect(sha256(secondBytes)).toBe(sha256(firstBytes));
    expect(loaded.metadata).toMatchObject({
      engine_version: '5.7.0',
      fingerprint_sha256: first.fingerprint_sha256,
      symbols_indexed: 3,
      search: { keyword: true, semantic: false },
    });
    expect(loaded.symbols.map((symbol) => symbol.name)).toEqual(['FActorIterator', 'Iterate', 'FOldIterator']);

    const serializedFile = firstBytes.toString('latin1');
    expect(serializedFile).not.toContain(source);
    expect(serializedFile).not.toContain(output);
    expect(serializedFile).not.toContain('.ue-header-index-staging');
    expect((await readdir(join(output, '.ue-header-index-staging'))).length).toBe(0);
  });

  it('rolls a cancelled transaction back and leaves the prior public database byte-for-byte intact', async () => {
    const { source, output } = await sandbox();
    const firstIndex = await fixtureIndex(source);
    await publishUeHeaderDatabase(firstIndex, {
      outputRoot: output,
      databaseFileName: 'ue.sqlite',
    });
    const before = await readFile(join(output, 'ue.sqlite'));

    const replacement = await fixtureIndex(source, true);
    let abortChecks = 0;
    const signal = {
      get aborted() {
        abortChecks++;
        return abortChecks >= 4; // Abort after the first one-row transaction commits to staging.
      },
    } as unknown as AbortSignal;
    await expect(
      publishUeHeaderDatabase(replacement, {
        outputRoot: output,
        databaseFileName: 'ue.sqlite',
        signal,
        budgets: { maxRowsPerTransaction: 1 },
      }),
    ).rejects.toMatchObject({ code: 'aborted' });

    const after = await readFile(join(output, 'ue.sqlite'));
    expect(after).toEqual(before);
    expect((await loadUeHeaderDatabase({ outputRoot: output, databaseFileName: 'ue.sqlite' })).symbols).toEqual(
      firstIndex.symbols,
    );
    expect((await readdir(join(output, '.ue-header-index-staging'))).length).toBe(0);
  });

  it('recovers from a corrupt public database only after a verified replacement is complete', async () => {
    const { source, output } = await sandbox();
    await writeFixture(source, true);
    const location = { outputRoot: output, databaseFileName: 'ue.sqlite' };
    await writeFile(join(output, 'ue.sqlite'), 'not a sqlite database', 'utf8');

    await expect(loadUeHeaderDatabase(location)).rejects.toMatchObject({ code: 'corrupt_database' });
    const rebuilt = await rebuildUeHeaderDatabase({ ...location, sourceRoot: source, engineVersion: '5.7' });
    expect(rebuilt).toMatchObject({ replaced_existing: true, symbols_written: 3 });
    const recovered = await loadUeHeaderDatabase(location);
    expect(recovered.metadata.fingerprint_sha256).toBe(rebuilt.fingerprint_sha256);
    expect(recovered.symbols).toHaveLength(3);
  });

  it('rejects fingerprint drift before staging and preserves the existing database', async () => {
    const { source, output } = await sandbox();
    const index = await fixtureIndex(source);
    const location = { outputRoot: output, databaseFileName: 'ue.sqlite' };
    await publishUeHeaderDatabase(index, location);
    const before = await readFile(join(output, 'ue.sqlite'));

    const forged = structuredClone(index);
    forged.symbols[0]!.signature = 'class FSomethingElse;';
    await expect(publishUeHeaderDatabase(forged, location)).rejects.toMatchObject({ code: 'invalid_index' });
    expect(await readFile(join(output, 'ue.sqlite'))).toEqual(before);
  });

  it('confines output to one filename and refuses symlink destinations without exposing private paths', async () => {
    const { root, source, output } = await sandbox();
    const index = await fixtureIndex(source);
    for (const databaseFileName of ['../escape.sqlite', 'nested/ue.sqlite', 'C:\\Private\\ue.sqlite']) {
      const attempt = publishUeHeaderDatabase(index, { outputRoot: output, databaseFileName });
      await expect(attempt).rejects.toMatchObject({ code: 'invalid_location' });
      await expect(attempt).rejects.not.toThrow(root);
    }

    const outside = join(root, 'outside.sqlite');
    await writeFile(outside, 'private', 'utf8');
    try {
      await symlink(outside, join(output, 'linked.sqlite'), 'file');
      await expect(
        publishUeHeaderDatabase(index, { outputRoot: output, databaseFileName: 'linked.sqlite' }),
      ).rejects.toMatchObject({ code: 'invalid_location' });
      expect(await readFile(outside, 'utf8')).toBe('private');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
  });

  it('bounds writes, reads and stale-file recovery', async () => {
    const { source, output } = await sandbox();
    const index = await fixtureIndex(source, true);
    const location = { outputRoot: output, databaseFileName: 'ue.sqlite' };
    await expect(publishUeHeaderDatabase(index, { ...location, budgets: { maxSymbols: 1 } })).rejects.toMatchObject({
      code: 'budget_exceeded',
    });

    const staging = join(output, '.ue-header-index-staging');
    await mkdir(staging, { mode: 0o700 });
    await writeFile(join(staging, '00000000-0000-0000-0000-000000000000.sqlite'), 'stale', 'utf8');
    await publishUeHeaderDatabase(index, location);
    expect(await readdir(staging)).toEqual([]);
    await expect(loadUeHeaderDatabase({ ...location, budgets: { maxSymbols: 1 } })).rejects.toMatchObject({
      code: 'budget_exceeded',
    });
  });

  it('fails closed on live SQLite sidecars instead of deleting another writer state', async () => {
    const { source, output } = await sandbox();
    const index = await fixtureIndex(source);
    const location = { outputRoot: output, databaseFileName: 'ue.sqlite' };
    await publishUeHeaderDatabase(index, location);
    const before = await readFile(join(output, 'ue.sqlite'));
    await writeFile(join(output, 'ue.sqlite-wal'), 'owned by another writer', 'utf8');

    await expect(loadUeHeaderDatabase(location)).rejects.toMatchObject({ code: 'corrupt_database' });
    await expect(publishUeHeaderDatabase(index, location)).rejects.toMatchObject({ code: 'publish_failed' });
    expect(await readFile(join(output, 'ue.sqlite'))).toEqual(before);
    expect(await readFile(join(output, 'ue.sqlite-wal'), 'utf8')).toBe('owned by another writer');
  });

  it('detects an old schema before reading rows, then permits a clean atomic rebuild', async () => {
    const { source, output } = await sandbox();
    const index = await fixtureIndex(source);
    const location = { outputRoot: output, databaseFileName: 'ue.sqlite' };
    await publishUeHeaderDatabase(index, location);
    const path = join(output, 'ue.sqlite');
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version=999');
    db.close();

    await expect(loadUeHeaderDatabase(location)).rejects.toMatchObject({ code: 'schema_mismatch' });
    const rebuilt = await publishUeHeaderDatabase(index, location);
    expect(rebuilt.replaced_existing).toBe(true);
    const loaded = await loadUeHeaderDatabase(location);
    expect(loaded.symbols).toEqual(index.symbols);

    const verified = new DatabaseSync(path, { readOnly: true });
    expect((verified.prepare('PRAGMA application_id').get() as { application_id: number }).application_id).toBe(
      UE_HEADER_DATABASE_APPLICATION_ID,
    );
    verified.close();
  });

  it('treats hostile row types and enum values as corruption even when SQLite itself is structurally sound', async () => {
    const { source, output } = await sandbox();
    const index = await fixtureIndex(source, true);
    const location = { outputRoot: output, databaseFileName: 'ue.sqlite' };
    await publishUeHeaderDatabase(index, location);
    const db = new DatabaseSync(join(output, 'ue.sqlite'));
    db.exec("UPDATE symbols SET deprecated=1, deprecation_marker='invented' WHERE ordinal=0");
    db.close();

    await expect(loadUeHeaderDatabase(location)).rejects.toMatchObject({ code: 'corrupt_database' });
  });
});
