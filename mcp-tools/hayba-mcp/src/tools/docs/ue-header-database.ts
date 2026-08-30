import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open as openFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  buildUeHeaderIndex,
  fingerprintUeHeaderSymbols,
  resolveUeHeaderIndexBudgets,
  UE_HEADER_INDEX_SCHEMA_VERSION,
  type BuildUeHeaderIndexOptions,
  type UeDeprecation,
  type UeHeaderIndex,
  type UeHeaderIndexMetadata,
  type UeHeaderSymbol,
  type UeHeaderSymbolKind,
} from './ue-header-index.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export const UE_HEADER_DATABASE_SCHEMA_VERSION = 1;
export const UE_HEADER_DATABASE_APPLICATION_ID = 0x48595544; // ASCII "HYUD".

const STAGING_DIRECTORY = '.ue-header-index-staging';
const STAGING_FILE = /^[0-9a-f-]{36}\.sqlite(?:-(?:journal|wal|shm))?$/u;
const DATABASE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.(?:db|sqlite)$/u;
const FINGERPRINT = /^[a-f0-9]{64}$/u;
const RECORD_ID = /^[a-f0-9]{24}$/u;
const KINDS = new Set<UeHeaderSymbolKind>(['class', 'struct', 'enum', 'function']);
const INCLUDE_CONFIDENCE = new Set(['canonical', 'private', 'fallback']);
const SOURCE_SCOPES = new Set(['public', 'classes', 'private', 'source']);
const DEPRECATION_MARKERS = new Set(['UE_DEPRECATED', 'UE_DEPRECATED_FORGAME', 'metadata', 'doc']);
const INDEX_SKIP_KEYS = [
  'directory_entry_limit',
  'file_limit',
  'file_too_large',
  'io_error',
  'path_too_long',
  'symbol_limit',
  'symlink',
  'total_byte_limit',
  'walk_depth',
] as const;

export type UeHeaderDatabaseErrorCode =
  | 'aborted'
  | 'budget_exceeded'
  | 'corrupt_database'
  | 'invalid_index'
  | 'invalid_location'
  | 'io_failure'
  | 'publish_failed'
  | 'schema_mismatch';

export class UeHeaderDatabaseError extends Error {
  constructor(
    readonly code: UeHeaderDatabaseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UeHeaderDatabaseError';
  }
}

export interface UeHeaderDatabaseLocation {
  /** Existing, non-symlink directory. It is deliberately never serialized into the database. */
  outputRoot: string;
  /** A single portable filename, not a path. */
  databaseFileName: string;
}

export interface UeHeaderDatabaseBudgets {
  maxSymbols: number;
  maxStoredTextChars: number;
  maxDatabaseBytes: number;
  maxStaleStagingFiles: number;
  maxRowsPerTransaction: number;
}

export interface PublishUeHeaderDatabaseOptions extends UeHeaderDatabaseLocation {
  budgets?: Partial<UeHeaderDatabaseBudgets>;
  signal?: AbortSignal;
}

export interface RebuildUeHeaderDatabaseOptions extends BuildUeHeaderIndexOptions, UeHeaderDatabaseLocation {
  databaseBudgets?: Partial<UeHeaderDatabaseBudgets>;
  signal?: AbortSignal;
}

export interface LoadUeHeaderDatabaseOptions extends UeHeaderDatabaseLocation {
  budgets?: Partial<Pick<UeHeaderDatabaseBudgets, 'maxSymbols' | 'maxStoredTextChars' | 'maxDatabaseBytes'>>;
}

export interface UeHeaderDatabasePublishResult {
  database_file: string;
  database_schema_version: number;
  index_schema_version: number;
  indexer_version: string;
  fingerprint_sha256: string;
  symbols_written: number;
  replaced_existing: boolean;
  atomic_publish: true;
  sqlite_synchronous: 'FULL';
  file_sync: 'completed';
  directory_sync: 'completed' | 'unsupported';
  final_permissions_adjusted: boolean;
  max_transaction_rows: number;
}

const DEFAULT_DATABASE_BUDGETS: UeHeaderDatabaseBudgets = {
  maxSymbols: 1_000_000,
  maxStoredTextChars: 512 * 1024 * 1024,
  maxDatabaseBytes: 2 * 1024 * 1024 * 1024,
  maxStaleStagingFiles: 64,
  maxRowsPerTransaction: 5_000,
};

const HARD_DATABASE_BUDGETS: UeHeaderDatabaseBudgets = {
  maxSymbols: 2_000_000,
  maxStoredTextChars: 1024 * 1024 * 1024,
  maxDatabaseBytes: 4 * 1024 * 1024 * 1024,
  maxStaleStagingFiles: 256,
  maxRowsPerTransaction: 50_000,
};

function databaseBudgets(overrides: Partial<UeHeaderDatabaseBudgets> = {}): UeHeaderDatabaseBudgets {
  const result = { ...DEFAULT_DATABASE_BUDGETS };
  for (const key of Object.keys(result) as Array<keyof UeHeaderDatabaseBudgets>) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1 || value > HARD_DATABASE_BUDGETS[key]) {
      throw new UeHeaderDatabaseError(
        'budget_exceeded',
        `${key} must be a positive safe integer no greater than ${HARD_DATABASE_BUDGETS[key]}`,
      );
    }
    result[key] = value;
  }
  return result;
}

function within(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

function portableRelative(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1_024 &&
    !isAbsolute(value) &&
    !value.includes('\\') &&
    !value.split('/').includes('..') &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function hasPrivateAbsolutePath(value: string): boolean {
  return (
    /\b[A-Za-z]:[\\/]/u.test(value) ||
    /\\{2}[A-Za-z0-9.$_-]+[\\/]/u.test(value) ||
    /(^|\s)\/(?:Users|home|root|tmp|mnt|private\/var)\//u.test(value)
  );
}

function assertPortableDatabaseFileName(value: string): void {
  if (!DATABASE_FILE.test(value) || value.includes('..')) {
    throw new UeHeaderDatabaseError(
      'invalid_location',
      'databaseFileName must be one portable .db or .sqlite filename, not a path',
    );
  }
}

async function canonicalOutputRoot(input: string): Promise<string> {
  if (!input.trim()) throw new UeHeaderDatabaseError('invalid_location', 'outputRoot is required');
  const requested = resolve(input);
  try {
    const requestedStat = await lstat(requested);
    if (requestedStat.isSymbolicLink() || !requestedStat.isDirectory()) {
      throw new UeHeaderDatabaseError('invalid_location', 'outputRoot must be an existing, non-symlink directory');
    }
    return await realpath(requested);
  } catch (error) {
    if (error instanceof UeHeaderDatabaseError) throw error;
    throw new UeHeaderDatabaseError('invalid_location', 'outputRoot must be an existing, non-symlink directory');
  }
}

async function checkedFinalPath(location: UeHeaderDatabaseLocation): Promise<{
  root: string;
  finalPath: string;
  exists: boolean;
}> {
  assertPortableDatabaseFileName(location.databaseFileName);
  const root = await canonicalOutputRoot(location.outputRoot);
  const finalPath = resolve(root, location.databaseFileName);
  if (!within(root, finalPath)) {
    throw new UeHeaderDatabaseError('invalid_location', 'database output escaped outputRoot');
  }
  try {
    const stat = await lstat(finalPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new UeHeaderDatabaseError(
        'invalid_location',
        'database destination must be absent or a regular, non-symlink file',
      );
    }
    const canonical = await realpath(finalPath);
    if (!within(root, canonical)) {
      throw new UeHeaderDatabaseError('invalid_location', 'database output escaped outputRoot');
    }
    return { root, finalPath, exists: true };
  } catch (error) {
    if (error instanceof UeHeaderDatabaseError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { root, finalPath, exists: false };
    throw new UeHeaderDatabaseError('io_failure', 'database destination could not be inspected');
  }
}

async function rejectLiveSidecars(
  finalPath: string,
  code: 'publish_failed' | 'corrupt_database' = 'publish_failed',
): Promise<void> {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    try {
      await lstat(`${finalPath}${suffix}`);
      throw new UeHeaderDatabaseError(code, 'database has a live SQLite sidecar; close its writer before rebuilding');
    } catch (error) {
      if (error instanceof UeHeaderDatabaseError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new UeHeaderDatabaseError('io_failure', 'database sidecars could not be inspected');
      }
    }
  }
}

async function prepareStaging(root: string, maxStaleFiles: number): Promise<string> {
  const requested = resolve(root, STAGING_DIRECTORY);
  try {
    await mkdir(requested, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new UeHeaderDatabaseError('io_failure', 'private staging directory could not be created');
    }
  }
  let stat;
  try {
    stat = await lstat(requested);
  } catch {
    throw new UeHeaderDatabaseError('io_failure', 'private staging directory could not be inspected');
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new UeHeaderDatabaseError('invalid_location', 'private staging must be a non-symlink directory');
  }
  const staging = await realpath(requested);
  if (!within(root, staging)) {
    throw new UeHeaderDatabaseError('invalid_location', 'private staging escaped outputRoot');
  }
  try {
    await chmod(staging, 0o700);
  } catch {
    throw new UeHeaderDatabaseError('io_failure', 'private staging permissions could not be restricted');
  }

  let stale = 0;
  let entries;
  try {
    entries = (await readdir(staging, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  } catch {
    throw new UeHeaderDatabaseError('io_failure', 'private staging could not be enumerated');
  }
  for (const entry of entries) {
    if (!STAGING_FILE.test(entry.name)) continue;
    stale++;
    if (stale > maxStaleFiles) {
      throw new UeHeaderDatabaseError('budget_exceeded', 'stale staging cleanup exceeded its configured file budget');
    }
    const candidate = resolve(staging, entry.name);
    const candidateStat = await lstat(candidate);
    if (candidateStat.isSymbolicLink() || !candidateStat.isFile()) {
      throw new UeHeaderDatabaseError('invalid_location', 'private staging contains a non-regular database artifact');
    }
    await rm(candidate, { force: true });
  }
  return staging;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    // Do not echo AbortSignal.reason: it may contain request payloads or credentials.
    throw new UeHeaderDatabaseError('aborted', 'UE header database rebuild was cancelled');
  }
}

function stableSymbolCompare(left: UeHeaderSymbol, right: UeHeaderSymbol): number {
  if (left.source_relpath !== right.source_relpath) return left.source_relpath < right.source_relpath ? -1 : 1;
  if (left.line !== right.line) return left.line - right.line;
  if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function storedTextChars(symbol: UeHeaderSymbol): number {
  return (
    symbol.id.length +
    symbol.kind.length +
    symbol.name.length +
    (symbol.owner?.length ?? 0) +
    symbol.signature.length +
    symbol.include.length +
    symbol.include_confidence.length +
    symbol.source_relpath.length +
    symbol.source_scope.length +
    (symbol.doc?.length ?? 0) +
    (symbol.deprecation?.marker.length ?? 0) +
    (symbol.deprecation?.version?.length ?? 0) +
    (symbol.deprecation?.message?.length ?? 0) +
    symbol.extraction.length
  );
}

function nonNegativeSafeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validOptionalString(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= max);
}

function assertValidMetadata(metadata: UeHeaderIndexMetadata): void {
  if (
    metadata.schema_version !== UE_HEADER_INDEX_SCHEMA_VERSION ||
    typeof metadata.indexer_version !== 'string' ||
    metadata.indexer_version.length < 1 ||
    metadata.indexer_version.length > 128 ||
    (metadata.engine_version !== null && typeof metadata.engine_version !== 'string') ||
    metadata.source_kind !== 'Engine/Source' ||
    metadata.parser !== 'bounded_heuristic' ||
    metadata.search?.keyword !== true ||
    metadata.search.semantic !== false ||
    typeof metadata.truncated !== 'boolean' ||
    !nonNegativeSafeInteger(metadata.files_seen) ||
    !nonNegativeSafeInteger(metadata.files_indexed) ||
    !nonNegativeSafeInteger(metadata.bytes_indexed) ||
    !nonNegativeSafeInteger(metadata.symbols_indexed)
  ) {
    throw new UeHeaderDatabaseError('invalid_index', 'index metadata is malformed');
  }
  if (
    metadata.files_indexed > metadata.files_seen ||
    (metadata.engine_version !== null &&
      (metadata.engine_version.length > 64 || /[\\/\u0000-\u001f\u007f]/u.test(metadata.engine_version)))
  ) {
    throw new UeHeaderDatabaseError('invalid_index', 'index metadata is internally inconsistent');
  }
  if (!metadata.skip_counts || typeof metadata.skip_counts !== 'object') {
    throw new UeHeaderDatabaseError('invalid_index', 'index skip metadata is malformed');
  }
  for (const key of INDEX_SKIP_KEYS) {
    if (!nonNegativeSafeInteger(metadata.skip_counts[key])) {
      throw new UeHeaderDatabaseError('invalid_index', 'index skip metadata is malformed');
    }
  }
  if (!metadata.budgets || typeof metadata.budgets !== 'object') {
    throw new UeHeaderDatabaseError('invalid_index', 'index build budgets are missing');
  }
  let normalizedBudgets;
  try {
    normalizedBudgets = resolveUeHeaderIndexBudgets(metadata.budgets);
  } catch {
    throw new UeHeaderDatabaseError('invalid_index', 'index carries invalid build budgets');
  }
  for (const key of Object.keys(normalizedBudgets) as Array<keyof typeof normalizedBudgets>) {
    if (metadata.budgets[key] !== normalizedBudgets[key]) {
      throw new UeHeaderDatabaseError('invalid_index', 'index build budgets are incomplete');
    }
  }
}

function assertValidIndex(index: UeHeaderIndex, budgets: UeHeaderDatabaseBudgets): void {
  if (!index || typeof index !== 'object' || !index.metadata || !Array.isArray(index.symbols)) {
    throw new UeHeaderDatabaseError('invalid_index', 'index envelope is missing metadata or symbols');
  }
  assertValidMetadata(index.metadata);
  if (index.symbols.length > budgets.maxSymbols) {
    throw new UeHeaderDatabaseError('budget_exceeded', 'index exceeds the database symbol budget');
  }
  if (index.metadata.symbols_indexed !== index.symbols.length) {
    throw new UeHeaderDatabaseError('invalid_index', 'index metadata symbol count does not match its records');
  }
  if (!FINGERPRINT.test(index.metadata.fingerprint_sha256)) {
    throw new UeHeaderDatabaseError('invalid_index', 'index fingerprint is malformed');
  }
  if (fingerprintUeHeaderSymbols(index.symbols) !== index.metadata.fingerprint_sha256) {
    throw new UeHeaderDatabaseError('invalid_index', 'index fingerprint does not match its records');
  }
  if (JSON.stringify(index.metadata).length > 128 * 1024) {
    throw new UeHeaderDatabaseError('budget_exceeded', 'index metadata exceeds its storage budget');
  }

  let textChars = 0;
  let previous: UeHeaderSymbol | undefined;
  const ids = new Set<string>();
  for (const symbol of index.symbols) {
    if (
      !symbol ||
      typeof symbol !== 'object' ||
      typeof symbol.id !== 'string' ||
      !RECORD_ID.test(symbol.id) ||
      typeof symbol.kind !== 'string' ||
      !KINDS.has(symbol.kind) ||
      typeof symbol.name !== 'string' ||
      !symbol.name ||
      symbol.name.length > 1_024 ||
      !validOptionalString(symbol.owner, 1_024) ||
      typeof symbol.signature !== 'string' ||
      symbol.signature.length > index.metadata.budgets.maxSignatureChars ||
      typeof symbol.include !== 'string' ||
      typeof symbol.include_confidence !== 'string' ||
      !INCLUDE_CONFIDENCE.has(symbol.include_confidence) ||
      typeof symbol.source_relpath !== 'string' ||
      typeof symbol.source_scope !== 'string' ||
      !SOURCE_SCOPES.has(symbol.source_scope) ||
      !portableRelative(symbol.source_relpath) ||
      !portableRelative(symbol.include) ||
      !Number.isSafeInteger(symbol.line) ||
      symbol.line < 1 ||
      !validOptionalString(symbol.doc, index.metadata.budgets.maxDocChars) ||
      typeof symbol.deprecated !== 'boolean' ||
      symbol.extraction !== 'bounded_heuristic' ||
      hasPrivateAbsolutePath(JSON.stringify(symbol))
    ) {
      throw new UeHeaderDatabaseError('invalid_index', 'index contains a malformed or non-portable symbol');
    }
    if (symbol.deprecated !== (symbol.deprecation !== undefined)) {
      throw new UeHeaderDatabaseError('invalid_index', 'symbol deprecation flag and metadata disagree');
    }
    if (
      symbol.deprecation &&
      (typeof symbol.deprecation !== 'object' ||
        typeof symbol.deprecation.marker !== 'string' ||
        !DEPRECATION_MARKERS.has(symbol.deprecation.marker) ||
        !validOptionalString(symbol.deprecation.version, 64) ||
        !validOptionalString(symbol.deprecation.message, 2_048))
    ) {
      throw new UeHeaderDatabaseError('invalid_index', 'symbol deprecation metadata is malformed');
    }
    if (ids.has(symbol.id)) {
      throw new UeHeaderDatabaseError('invalid_index', 'index contains duplicate record ids');
    }
    ids.add(symbol.id);
    if (previous && stableSymbolCompare(previous, symbol) > 0) {
      throw new UeHeaderDatabaseError('invalid_index', 'index records are not in deterministic order');
    }
    previous = symbol;
    textChars += storedTextChars(symbol);
    if (textChars > budgets.maxStoredTextChars) {
      throw new UeHeaderDatabaseError('budget_exceeded', 'index exceeds the database text budget');
    }
  }
}

function configureNewDatabase(db: InstanceType<typeof DatabaseSync>): void {
  db.exec(`
    PRAGMA page_size=4096;
    PRAGMA journal_mode=DELETE;
    PRAGMA synchronous=FULL;
    PRAGMA temp_store=MEMORY;
    PRAGMA foreign_keys=ON;
    PRAGMA trusted_schema=OFF;
    PRAGMA application_id=${UE_HEADER_DATABASE_APPLICATION_ID};
    PRAGMA user_version=${UE_HEADER_DATABASE_SCHEMA_VERSION};
    CREATE TABLE metadata (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE symbols (
      ordinal INTEGER PRIMARY KEY NOT NULL CHECK (ordinal >= 0),
      id TEXT UNIQUE NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('class','struct','enum','function')),
      name TEXT NOT NULL,
      owner TEXT,
      signature TEXT NOT NULL,
      include_path TEXT NOT NULL,
      include_confidence TEXT NOT NULL CHECK (include_confidence IN ('canonical','private','fallback')),
      source_relpath TEXT NOT NULL,
      source_scope TEXT NOT NULL CHECK (source_scope IN ('public','classes','private','source')),
      source_line INTEGER NOT NULL CHECK (source_line >= 1),
      doc TEXT,
      deprecated INTEGER NOT NULL CHECK (deprecated IN (0,1)),
      deprecation_marker TEXT,
      deprecation_version TEXT,
      deprecation_message TEXT,
      extraction TEXT NOT NULL CHECK (extraction = 'bounded_heuristic')
    ) STRICT;
    CREATE INDEX symbols_name ON symbols(name);
    CREATE INDEX symbols_owner ON symbols(owner) WHERE owner IS NOT NULL;
    CREATE INDEX symbols_kind ON symbols(kind);
    CREATE INDEX symbols_deprecated ON symbols(deprecated) WHERE deprecated = 1;
  `);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolveYield) => setImmediate(resolveYield));
}

async function writeDatabase(
  db: InstanceType<typeof DatabaseSync>,
  index: UeHeaderIndex,
  signal: AbortSignal | undefined,
  maxRowsPerTransaction: number,
): Promise<void> {
  const insertMetadata = db.prepare('INSERT INTO metadata(key,value) VALUES (?,?)');
  const insertSymbol = db.prepare(`
    INSERT INTO symbols(
      ordinal,id,kind,name,owner,signature,include_path,include_confidence,
      source_relpath,source_scope,source_line,doc,deprecated,
      deprecation_marker,deprecation_version,deprecation_message,extraction
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  for (let start = 0; start < index.symbols.length; start += maxRowsPerTransaction) {
    throwIfAborted(signal);
    db.exec('BEGIN IMMEDIATE');
    try {
      const end = Math.min(index.symbols.length, start + maxRowsPerTransaction);
      for (let ordinal = start; ordinal < end; ordinal++) {
        throwIfAborted(signal);
        const symbol = index.symbols[ordinal]!;
        insertSymbol.run(
          ordinal,
          symbol.id,
          symbol.kind,
          symbol.name,
          symbol.owner ?? null,
          symbol.signature,
          symbol.include,
          symbol.include_confidence,
          symbol.source_relpath,
          symbol.source_scope,
          symbol.line,
          symbol.doc ?? null,
          symbol.deprecated ? 1 : 0,
          symbol.deprecation?.marker ?? null,
          symbol.deprecation?.version ?? null,
          symbol.deprecation?.message ?? null,
          symbol.extraction,
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The staging database is deleted below; never obscure the original bounded error.
      }
      throw error;
    }
    // DatabaseSync is synchronous. Yield between bounded transactions so a real AbortController,
    // shutdown signal or competing server work can be observed before the next chunk.
    await yieldToEventLoop();
  }

  throwIfAborted(signal);
  db.exec('BEGIN IMMEDIATE');
  try {
    insertMetadata.run('complete', JSON.stringify(true));
    insertMetadata.run('database_schema_version', JSON.stringify(UE_HEADER_DATABASE_SCHEMA_VERSION));
    insertMetadata.run('index_metadata', JSON.stringify(index.metadata));
    insertMetadata.run('fingerprint_sha256', JSON.stringify(index.metadata.fingerprint_sha256));
    insertMetadata.run('symbol_count', JSON.stringify(index.symbols.length));
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The staging database is deleted below; never obscure the original bounded error.
    }
    throw error;
  }
}

function quickCheck(db: InstanceType<typeof DatabaseSync>): void {
  const row = db.prepare('PRAGMA quick_check(1)').get() as Record<string, unknown> | undefined;
  if (!row || Object.values(row)[0] !== 'ok') {
    throw new UeHeaderDatabaseError('corrupt_database', 'SQLite quick_check rejected the UE header database');
  }
}

function verifyStagingDatabase(path: string, index: UeHeaderIndex): void {
  let db: InstanceType<typeof DatabaseSync> | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
    quickCheck(db);
    const count = db.prepare('SELECT COUNT(*) AS n FROM symbols').get() as { n: number };
    const fingerprintRow = db.prepare("SELECT value FROM metadata WHERE key='fingerprint_sha256'").get() as
      { value: string } | undefined;
    const completeRow = db.prepare("SELECT value FROM metadata WHERE key='complete'").get() as
      { value: string } | undefined;
    if (
      Number(count.n) !== index.symbols.length ||
      !fingerprintRow ||
      JSON.parse(fingerprintRow.value) !== index.metadata.fingerprint_sha256 ||
      !completeRow ||
      JSON.parse(completeRow.value) !== true
    ) {
      throw new UeHeaderDatabaseError('corrupt_database', 'staging database verification failed');
    }
  } catch (error) {
    if (error instanceof UeHeaderDatabaseError) throw error;
    throw new UeHeaderDatabaseError('corrupt_database', 'staging database could not be verified');
  } finally {
    try {
      db?.close();
    } catch {
      // The staging file is still never published.
    }
  }
}

async function syncFile(path: string): Promise<void> {
  // Windows rejects FlushFileBuffers on a read-only handle (EPERM); r+ grants the write bit the
  // operation requires without changing the verified bytes.
  const handle = await openFile(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<'completed' | 'unsupported'> {
  try {
    const handle = await openFile(path, 'r');
    try {
      await handle.sync();
      return 'completed';
    } finally {
      await handle.close();
    }
  } catch {
    // Windows does not provide a directory fsync through Node. SQLite FULL + file fsync still
    // protects the database contents; report the weaker directory durability instead of lying.
    return 'unsupported';
  }
}

async function cleanupStagingFile(path: string): Promise<void> {
  await Promise.all(
    ['', '-journal', '-wal', '-shm'].map((suffix) => rm(`${path}${suffix}`, { force: true }).catch(() => undefined)),
  );
}

export async function publishUeHeaderDatabase(
  index: UeHeaderIndex,
  options: PublishUeHeaderDatabaseOptions,
): Promise<UeHeaderDatabasePublishResult> {
  const budgets = databaseBudgets(options.budgets);
  assertValidIndex(index, budgets);
  throwIfAborted(options.signal);
  const destination = await checkedFinalPath(options);
  await rejectLiveSidecars(destination.finalPath);
  const stagingDirectory = await prepareStaging(destination.root, budgets.maxStaleStagingFiles);
  const stagingPath = resolve(stagingDirectory, `${randomUUID()}.sqlite`);
  if (!within(stagingDirectory, stagingPath)) {
    throw new UeHeaderDatabaseError('invalid_location', 'private staging path escaped its directory');
  }

  let db: InstanceType<typeof DatabaseSync> | undefined;
  let published = false;
  try {
    db = new DatabaseSync(stagingPath);
    await chmod(stagingPath, 0o600);
    configureNewDatabase(db);
    await writeDatabase(db, index, options.signal, budgets.maxRowsPerTransaction);
    db.close();
    db = undefined;
    verifyStagingDatabase(stagingPath, index);
    const stageStat = await lstat(stagingPath);
    if (!stageStat.isFile() || stageStat.size > budgets.maxDatabaseBytes) {
      throw new UeHeaderDatabaseError('budget_exceeded', 'staging database exceeds its file-size budget');
    }
    await syncFile(stagingPath);
    try {
      await rename(stagingPath, destination.finalPath);
    } catch {
      throw new UeHeaderDatabaseError(
        'publish_failed',
        'atomic database replacement failed; the previous database was preserved',
      );
    }
    published = true;
    const directorySync = await syncDirectory(destination.root);
    let permissionsAdjusted = true;
    try {
      await chmod(destination.finalPath, 0o644);
    } catch {
      permissionsAdjusted = false;
    }
    return {
      database_file: options.databaseFileName,
      database_schema_version: UE_HEADER_DATABASE_SCHEMA_VERSION,
      index_schema_version: index.metadata.schema_version,
      indexer_version: index.metadata.indexer_version,
      fingerprint_sha256: index.metadata.fingerprint_sha256,
      symbols_written: index.symbols.length,
      replaced_existing: destination.exists,
      atomic_publish: true,
      sqlite_synchronous: 'FULL',
      file_sync: 'completed',
      directory_sync: directorySync,
      final_permissions_adjusted: permissionsAdjusted,
      max_transaction_rows: budgets.maxRowsPerTransaction,
    };
  } catch (error) {
    if (error instanceof UeHeaderDatabaseError) throw error;
    throw new UeHeaderDatabaseError('io_failure', 'UE header database staging failed');
  } finally {
    try {
      db?.close();
    } catch {
      // Cleanup below owns the incomplete staging file.
    }
    if (!published) await cleanupStagingFile(stagingPath);
  }
}

export async function rebuildUeHeaderDatabase(
  options: RebuildUeHeaderDatabaseOptions,
): Promise<UeHeaderDatabasePublishResult> {
  throwIfAborted(options.signal);
  const index = await buildUeHeaderIndex({
    sourceRoot: options.sourceRoot,
    engineVersion: options.engineVersion,
    budgets: options.budgets,
  });
  return publishUeHeaderDatabase(index, {
    outputRoot: options.outputRoot,
    databaseFileName: options.databaseFileName,
    budgets: options.databaseBudgets,
    signal: options.signal,
  });
}

function metadataMap(db: InstanceType<typeof DatabaseSync>): Map<string, unknown> {
  const rows = db.prepare('SELECT key,value FROM metadata ORDER BY key LIMIT 17').all() as Array<{
    key: string;
    value: string;
  }>;
  if (rows.length > 16) throw new UeHeaderDatabaseError('corrupt_database', 'database metadata row budget exceeded');
  const result = new Map<string, unknown>();
  for (const row of rows) {
    if (row.key.length > 128 || row.value.length > 128 * 1024 || result.has(row.key)) {
      throw new UeHeaderDatabaseError('corrupt_database', 'database metadata is malformed');
    }
    try {
      result.set(row.key, JSON.parse(row.value));
    } catch {
      throw new UeHeaderDatabaseError('corrupt_database', 'database metadata is not valid JSON');
    }
  }
  return result;
}

function rowToSymbol(row: Record<string, unknown>): UeHeaderSymbol {
  const marker = row.deprecation_marker as UeDeprecation['marker'] | null;
  const deprecation = marker
    ? {
        marker,
        ...((row.deprecation_version as string | null) ? { version: row.deprecation_version as string } : {}),
        ...((row.deprecation_message as string | null) ? { message: row.deprecation_message as string } : {}),
      }
    : undefined;
  return {
    id: row.id as string,
    kind: row.kind as UeHeaderSymbolKind,
    name: row.name as string,
    ...((row.owner as string | null) ? { owner: row.owner as string } : {}),
    signature: row.signature as string,
    include: row.include_path as string,
    include_confidence: row.include_confidence as UeHeaderSymbol['include_confidence'],
    source_relpath: row.source_relpath as string,
    source_scope: row.source_scope as UeHeaderSymbol['source_scope'],
    line: Number(row.source_line),
    ...((row.doc as string | null) ? { doc: row.doc as string } : {}),
    deprecated: Number(row.deprecated) === 1,
    ...(deprecation ? { deprecation } : {}),
    extraction: row.extraction as UeHeaderSymbol['extraction'],
  };
}

export async function loadUeHeaderDatabase(options: LoadUeHeaderDatabaseOptions): Promise<UeHeaderIndex> {
  const budgets = databaseBudgets(options.budgets);
  const destination = await checkedFinalPath(options);
  if (!destination.exists) {
    throw new UeHeaderDatabaseError('io_failure', 'UE header database does not exist');
  }
  await rejectLiveSidecars(destination.finalPath, 'corrupt_database');
  const stat = await lstat(destination.finalPath);
  if (stat.size > budgets.maxDatabaseBytes) {
    throw new UeHeaderDatabaseError('budget_exceeded', 'database exceeds its read file-size budget');
  }

  let db: InstanceType<typeof DatabaseSync> | undefined;
  try {
    db = new DatabaseSync(destination.finalPath, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
    const application = db.prepare('PRAGMA application_id').get() as { application_id: number };
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (
      Number(application.application_id) !== UE_HEADER_DATABASE_APPLICATION_ID ||
      Number(version.user_version) !== UE_HEADER_DATABASE_SCHEMA_VERSION
    ) {
      throw new UeHeaderDatabaseError('schema_mismatch', 'database application or schema version is not supported');
    }
    quickCheck(db);
    const metadata = metadataMap(db);
    if (
      metadata.get('complete') !== true ||
      metadata.get('database_schema_version') !== UE_HEADER_DATABASE_SCHEMA_VERSION
    ) {
      throw new UeHeaderDatabaseError('corrupt_database', 'database is not marked as a complete rebuild');
    }
    const indexMetadata = metadata.get('index_metadata') as UeHeaderIndexMetadata | undefined;
    if (!indexMetadata || typeof indexMetadata !== 'object') {
      throw new UeHeaderDatabaseError('corrupt_database', 'database is missing index metadata');
    }
    const rows = db
      .prepare(
        `SELECT ordinal,id,kind,name,owner,signature,include_path,include_confidence,
                source_relpath,source_scope,source_line,doc,deprecated,
                deprecation_marker,deprecation_version,deprecation_message,extraction
         FROM symbols ORDER BY ordinal LIMIT ?`,
      )
      .all(budgets.maxSymbols + 1) as Array<Record<string, unknown>>;
    if (rows.length > budgets.maxSymbols) {
      throw new UeHeaderDatabaseError('budget_exceeded', 'database exceeds its read symbol budget');
    }
    for (const [expectedOrdinal, row] of rows.entries()) {
      if (Number(row.ordinal) !== expectedOrdinal) {
        throw new UeHeaderDatabaseError('corrupt_database', 'database symbol ordinals are not contiguous');
      }
    }
    const index: UeHeaderIndex = { metadata: indexMetadata, symbols: rows.map(rowToSymbol) };
    if (
      metadata.get('symbol_count') !== index.symbols.length ||
      metadata.get('fingerprint_sha256') !== index.metadata.fingerprint_sha256
    ) {
      throw new UeHeaderDatabaseError('corrupt_database', 'database metadata does not match its records');
    }
    try {
      assertValidIndex(index, budgets);
    } catch (error) {
      if (error instanceof UeHeaderDatabaseError && error.code === 'invalid_index') {
        throw new UeHeaderDatabaseError('corrupt_database', 'database contains invalid index records');
      }
      throw error;
    }
    return index;
  } catch (error) {
    if (error instanceof UeHeaderDatabaseError) throw error;
    throw new UeHeaderDatabaseError('corrupt_database', 'database could not be opened or read safely');
  } finally {
    try {
      db?.close();
    } catch {
      // Read errors are already classified above.
    }
  }
}
