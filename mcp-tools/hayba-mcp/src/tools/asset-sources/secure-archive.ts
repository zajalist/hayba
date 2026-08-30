import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable, Transform, Writable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';

/**
 * Security budgets for data fetched from asset marketplaces. These are hard
 * ceilings, not tuning hints: callers may lower them, but cannot disable them.
 */
export interface ArchiveLimits {
  maxDownloadBytes: number;
  downloadTimeoutMs: number;
  maxMetadataBytes: number;
  metadataTimeoutMs: number;
  extractionTimeoutMs: number;
  maxEntries: number;
  maxCentralDirectoryBytes: number;
  maxNameBytes: number;
  maxExtraFieldBytes: number;
  maxDepth: number;
  maxEntryCompressedBytes: number;
  maxEntryUncompressedBytes: number;
  maxTotalUncompressedBytes: number;
  maxCompressionRatio: number;
}

export const DEFAULT_ARCHIVE_LIMITS: Readonly<ArchiveLimits> = Object.freeze({
  maxDownloadBytes: 512 * 1024 * 1024,
  downloadTimeoutMs: 120_000,
  maxMetadataBytes: 8 * 1024 * 1024,
  metadataTimeoutMs: 30_000,
  extractionTimeoutMs: 120_000,
  maxEntries: 4_096,
  maxCentralDirectoryBytes: 16 * 1024 * 1024,
  maxNameBytes: 1_024,
  maxExtraFieldBytes: 4_096,
  maxDepth: 32,
  maxEntryCompressedBytes: 512 * 1024 * 1024,
  maxEntryUncompressedBytes: 256 * 1024 * 1024,
  maxTotalUncompressedBytes: 2 * 1024 * 1024 * 1024,
  maxCompressionRatio: 200,
});

export class ArchiveSecurityError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ArchiveSecurityError';
  }
}

export interface ConnectorFailureFacts {
  primary_error: string;
  primary_code?: string;
  cleanup_failed: boolean;
  retained_count: number;
  retained_path_refs: string[];
  cleanup_error?: string;
}

/** Preserves the refusal that caused cleanup while carrying bounded cleanup facts. */
export class ConnectorCleanupError extends Error {
  readonly cleanup_failed = true;

  constructor(
    public readonly primary: unknown,
    public readonly retainedPaths: string[],
    public readonly cleanupError: unknown,
  ) {
    super(primary instanceof Error ? primary.message : String(primary));
    this.name = 'ConnectorCleanupError';
  }
}

const MAX_RETAINED_PATH_REFS = 8;
const SAFE_PLATFORM_ERROR_CODES = new Set([
  'EACCES',
  'EBUSY',
  'EEXIST',
  'EIO',
  'EISDIR',
  'ELOOP',
  'EMFILE',
  'ENAMETOOLONG',
  'ENFILE',
  'ENOENT',
  'ENOSPC',
  'ENOTDIR',
  'ENOTEMPTY',
  'EPERM',
  'EROFS',
]);

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_-]{0,63}$/.test(code)) return undefined;
  return code.startsWith('HAYBA-') || SAFE_PLATFORM_ERROR_CODES.has(code) ? code : undefined;
}

function isStableHaybaError(error: unknown): error is Error & { code: string } {
  if (!(error instanceof Error)) return false;
  const code = errorCode(error);
  return (
    (error.name === 'ArchiveSecurityError' && Boolean(code?.startsWith('HAYBA-ARCHIVE-'))) ||
    (error.name === 'AssetEnumerationError' && Boolean(code?.startsWith('HAYBA-ASSET-')))
  );
}

function publicPrimaryError(error: unknown): string {
  return isStableHaybaError(error) ? error.message.slice(0, 512) : 'connector operation failed unexpectedly';
}

function publicCleanupError(error: unknown): string {
  return errorCode(error) ?? 'cleanup operation failed unexpectedly';
}

function retainedPathRef(candidate: string): string {
  const resolved = path.normalize(path.resolve(candidate));
  const normalized = process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  return `sha256:${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fsp.lstat(candidate);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    return true;
  }
}

function containsPath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function connectorFailureFacts(error: unknown): ConnectorFailureFacts {
  if (error instanceof ConnectorCleanupError) {
    const primary = error.primary instanceof ConnectorCleanupError ? error.primary.primary : error.primary;
    const retained = [...new Set(error.retainedPaths.map((item) => path.resolve(item)))];
    return {
      primary_error: publicPrimaryError(primary),
      ...(errorCode(primary) ? { primary_code: errorCode(primary) } : {}),
      cleanup_failed: true,
      retained_count: retained.length,
      retained_path_refs: retained.slice(0, MAX_RETAINED_PATH_REFS).map(retainedPathRef),
      cleanup_error: publicCleanupError(error.cleanupError),
    };
  }
  return {
    primary_error: publicPrimaryError(error),
    ...(errorCode(error) ? { primary_code: errorCode(error) } : {}),
    cleanup_failed: false,
    retained_count: 0,
    retained_path_refs: [],
  };
}

type RemoveTree = (root: string) => Promise<void>;

const removeTree: RemoveTree = async (root) => fsp.rm(root, { recursive: true, force: true });

/**
 * Attempt cleanup without ever replacing the original refusal. A successful
 * broader cleanup also clears an earlier nested cleanup failure when it covers
 * every retained path.
 */
export async function cleanupAfterRefusal(
  primary: unknown,
  cleanupRoot: string,
  remove: RemoveTree = removeTree,
): Promise<unknown> {
  const root = path.resolve(cleanupRoot);
  try {
    await remove(root);
    if (primary instanceof ConnectorCleanupError) {
      if (primary.retainedPaths.length === 0) return primary;
      const unresolved = primary.retainedPaths.filter((candidate) => !containsPath(root, candidate));
      return unresolved.length === 0
        ? primary.primary
        : new ConnectorCleanupError(primary.primary, unresolved, primary.cleanupError);
    }
    return primary;
  } catch (cleanupError: unknown) {
    const inherited = primary instanceof ConnectorCleanupError ? primary.retainedPaths : [];
    const retained: string[] = [];
    for (const candidate of inherited) {
      if (await pathExists(candidate)) retained.push(candidate);
    }
    if (await pathExists(root)) retained.push(root);
    const original = primary instanceof ConnectorCleanupError ? primary.primary : primary;
    return new ConnectorCleanupError(original, retained, cleanupError);
  }
}

/** @internal Deterministic test seam; production connector calls never supply it. */
export interface ArchiveExtractionTestHooks {
  afterStageReady?: () => Promise<void>;
}

/** @internal Deterministic cleanup-failure seam; production connector calls never supply it. */
export interface DownloadExtractTestHooks {
  removeFailureCleanupRoot?: (root: string) => Promise<void>;
}

function checkedLimits(overrides?: Partial<ArchiveLimits>): ArchiveLimits {
  const merged = { ...DEFAULT_ARCHIVE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ArchiveSecurityError('HAYBA-ARCHIVE-LIMIT', `${name} must be a positive safe integer`);
    }
  }
  return merged;
}

class ByteLimitTransform extends Transform {
  bytes = 0;

  constructor(
    private readonly maximum: number,
    private readonly errorCode: string,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maximum) {
      callback(new ArchiveSecurityError(this.errorCode, `stream exceeded ${this.maximum} bytes`));
      return;
    }
    callback(null, chunk);
  }
}

/** Bounded JSON reader for the provider lookup immediately before download. */
export async function fetchJsonBounded<T>(
  url: string,
  headers?: Record<string, string>,
  overrides?: Partial<ArchiveLimits>,
): Promise<T> {
  const limits = checkedLimits(overrides);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('metadata deadline exceeded')), limits.metadataTimeoutMs);
  timeout.unref?.();
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new ArchiveSecurityError('HAYBA-METADATA-HTTP', `provider lookup failed: ${response.status}`);
    }
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null) {
      const parsed = Number(declaredLength);
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > limits.maxMetadataBytes) {
        throw new ArchiveSecurityError('HAYBA-METADATA-SIZE', 'provider metadata exceeds its byte ceiling');
      }
    }

    const chunks: Buffer[] = [];
    const collector = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    const limiter = new ByteLimitTransform(limits.maxMetadataBytes, 'HAYBA-METADATA-SIZE');
    await pipeline(Readable.fromWeb(response.body as never), limiter, collector, { signal: controller.signal });
    if (controller.signal.aborted) {
      throw new ArchiveSecurityError('HAYBA-METADATA-TIMEOUT', 'provider metadata deadline exceeded');
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      return JSON.parse(text) as T;
    } catch {
      throw new ArchiveSecurityError('HAYBA-METADATA-JSON', 'provider returned malformed UTF-8 JSON metadata');
    }
  } catch (error: unknown) {
    if (controller.signal.aborted && !(error instanceof ArchiveSecurityError)) {
      throw new ArchiveSecurityError('HAYBA-METADATA-TIMEOUT', 'provider metadata deadline exceeded');
    }
    if (error instanceof ArchiveSecurityError) throw error;
    const code = (error as NodeJS.ErrnoException)?.code;
    throw new ArchiveSecurityError(
      'HAYBA-METADATA-NETWORK',
      code ? `provider lookup failed (${code})` : 'provider lookup failed',
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Downloads into a private sibling directory, aborts at the byte/deadline
 * boundary, and only then publishes the file. The final path is never opened
 * for writing and an existing file is never replaced.
 */
export async function downloadToFile(
  url: string,
  dest: string,
  headers?: Record<string, string>,
  overrides?: Partial<ArchiveLimits>,
): Promise<void> {
  const limits = checkedLimits(overrides);
  const parent = path.dirname(dest);
  await fsp.mkdir(parent, { recursive: true });
  const tempRoot = await fsp.mkdtemp(path.join(parent, '.hayba-download-'));
  const tempFile = path.join(tempRoot, 'payload');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('download deadline exceeded')), limits.downloadTimeoutMs);
  timeout.unref?.();
  let failure: unknown;

  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok || !res.body) {
      throw new ArchiveSecurityError('HAYBA-DOWNLOAD-HTTP', `download failed: ${res.status} ${res.statusText}`);
    }

    const declaredLength = res.headers.get('content-length');
    if (declaredLength !== null) {
      const parsed = Number(declaredLength);
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > limits.maxDownloadBytes) {
        throw new ArchiveSecurityError(
          'HAYBA-DOWNLOAD-SIZE',
          `declared content length is invalid or exceeds ${limits.maxDownloadBytes} bytes`,
        );
      }
    }

    const limiter = new ByteLimitTransform(limits.maxDownloadBytes, 'HAYBA-DOWNLOAD-SIZE');
    const out = fs.createWriteStream(tempFile, { flags: 'wx', mode: 0o600 });
    const body = Readable.fromWeb(res.body as never);
    await pipeline(body, limiter, out, { signal: controller.signal });
    if (controller.signal.aborted) {
      throw new ArchiveSecurityError('HAYBA-DOWNLOAD-TIMEOUT', `download exceeded ${limits.downloadTimeoutMs} ms`);
    }

    // A hard link is an atomic, no-clobber publication on the same volume.
    // The private source is unlinked afterwards; no partially downloaded final
    // path is ever observable.
    try {
      await fsp.link(tempFile, dest);
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'EEXIST') {
        throw new ArchiveSecurityError(
          'HAYBA-DOWNLOAD-COLLISION',
          'destination already exists; refusing to overwrite it',
        );
      }
      throw error;
    }
  } catch (error: unknown) {
    if (controller.signal.aborted && !(error instanceof ArchiveSecurityError)) {
      failure = new ArchiveSecurityError('HAYBA-DOWNLOAD-TIMEOUT', `download exceeded ${limits.downloadTimeoutMs} ms`);
    } else if (error instanceof ArchiveSecurityError) {
      failure = error;
    } else {
      const code = (error as NodeJS.ErrnoException)?.code;
      failure = new ArchiveSecurityError(
        'HAYBA-DOWNLOAD-NETWORK',
        code ? `network/filesystem failure (${code})` : 'network/filesystem failure',
      );
    }
  } finally {
    clearTimeout(timeout);
  }
  if (failure !== undefined) throw await cleanupAfterRefusal(failure, tempRoot);
  const cleanupMarker = new ArchiveSecurityError(
    'HAYBA-DOWNLOAD-CLEANUP',
    'download published but private staging cleanup could not be established',
  );
  const cleanupResult = await cleanupAfterRefusal(cleanupMarker, tempRoot);
  if (cleanupResult instanceof ConnectorCleanupError) {
    throw cleanupResult;
  }
}

interface ZipEntry {
  rawName: Buffer;
  name: string;
  segments: string[];
  isDirectory: boolean;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  dataOffset: number;
}

interface ZipPlan {
  entries: ZipEntry[];
  archiveBytes: number;
  totalUncompressedBytes: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_FIXED_BYTES = 22;
const CENTRAL_FIXED_BYTES = 46;
const LOCAL_FIXED_BYTES = 30;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;
const UNIX_FILE_TYPE_MASK = 0xf000;
const UNIX_DIRECTORY = 0x4000;
const UNIX_REGULAR = 0x8000;
const UNIX_SYMLINK = 0xa000;

function throwIfArchiveAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ArchiveSecurityError('HAYBA-ARCHIVE-TIMEOUT', 'archive validation/extraction deadline exceeded');
  }
}

async function readExactly(
  handle: fsp.FileHandle,
  length: number,
  position: number,
  signal: AbortSignal,
): Promise<Buffer> {
  throwIfArchiveAborted(signal);
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  throwIfArchiveAborted(signal);
  if (bytesRead !== length) {
    throw new ArchiveSecurityError('HAYBA-ARCHIVE-TRUNCATED', 'archive ended before declared metadata or data');
  }
  return buffer;
}

function rejectUnsafeName(
  rawName: Buffer,
  limits: ArchiveLimits,
): { name: string; segments: string[]; isDirectory: boolean } {
  if (rawName.length === 0 || rawName.length > limits.maxNameBytes) {
    throw new ArchiveSecurityError('HAYBA-ARCHIVE-NAME', `entry filename must be 1..${limits.maxNameBytes} bytes`);
  }
  if (rawName.includes(0)) {
    throw new ArchiveSecurityError('HAYBA-ARCHIVE-NAME', 'entry filename contains NUL');
  }

  const name = rawName.toString('utf8');
  if (!Buffer.from(name, 'utf8').equals(rawName)) {
    throw new ArchiveSecurityError('HAYBA-ARCHIVE-NAME', 'entry filename is not valid UTF-8');
  }
  if (name.includes('\\')) {
    throw new ArchiveSecurityError('HAYBA-ARCHIVE-PATH', 'backslashes are forbidden in archive paths');
  }
  if (
    name.startsWith('/') ||
    name.startsWith('//') ||
    /^[a-zA-Z]:/.test(name) ||
    /^(?:\\\\|\\\?|\\\.|\/\?\?\/)/.test(name)
  ) {
    throw new ArchiveSecurityError('HAYBA-ARCHIVE-PATH', 'absolute, drive, UNC, and device paths are forbidden');
  }

  const isDirectory = name.endsWith('/');
  const body = isDirectory ? name.slice(0, -1) : name;
  const segments = body.split('/');
  if (segments.length === 0 || segments.length > limits.maxDepth) {
    throw new ArchiveSecurityError('HAYBA-ARCHIVE-DEPTH', `entry path exceeds ${limits.maxDepth} segments`);
  }

  const reserved = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  for (const segment of segments) {
    const normalized = segment.normalize('NFC');
    const hasForbiddenCharacter = [...segment].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f || '<>"|?*'.includes(character);
    });
    if (
      !segment ||
      segment === '.' ||
      segment === '..' ||
      normalized !== segment ||
      segment.normalize('NFKC') !== segment ||
      segment.includes(':') ||
      hasForbiddenCharacter ||
      /[. ]$/.test(segment) ||
      reserved.test(segment)
    ) {
      throw new ArchiveSecurityError(
        'HAYBA-ARCHIVE-PATH',
        'empty, dot, non-canonical Unicode, ADS, trailing-dot/space, and device-name components are forbidden',
      );
    }
  }
  return { name, segments, isDirectory };
}

/** Validates provider metadata before a filename is joined to a cache root. */
export function safeDownloadLeafName(name: string): string {
  const safe = rejectUnsafeName(Buffer.from(name, 'utf8'), checkedLimits());
  if (safe.isDirectory || safe.segments.length !== 1) {
    throw new ArchiveSecurityError('HAYBA-DOWNLOAD-NAME', 'download filename must be one safe path component');
  }
  return safe.segments[0]!;
}

function inspectExternalAttributes(versionMadeBy: number, externalAttributes: number, isDirectory: boolean): void {
  const host = versionMadeBy >>> 8;
  const unixMode = externalAttributes >>> 16;
  const unixType = unixMode & UNIX_FILE_TYPE_MASK;
  if (unixType === UNIX_SYMLINK || (unixType !== 0 && unixType !== UNIX_REGULAR && unixType !== UNIX_DIRECTORY)) {
    throw new ArchiveSecurityError('HAYBA-ARCHIVE-LINK', 'links and special filesystem entries are forbidden');
  }
  if (host === 3 && (unixType === UNIX_DIRECTORY) !== isDirectory) {
    throw new ArchiveSecurityError('HAYBA-ARCHIVE-TYPE', 'directory metadata disagrees with the entry name');
  }
  const dosDirectory = (externalAttributes & 0x10) !== 0;
  if (host !== 3 && dosDirectory !== isDirectory) {
    throw new ArchiveSecurityError('HAYBA-ARCHIVE-TYPE', 'DOS directory metadata disagrees with the entry name');
  }
  // Some producers place FILE_ATTRIBUTE_REPARSE_POINT in either half.
  if ((externalAttributes & 0x400) !== 0 || ((externalAttributes >>> 16) & 0x400) !== 0) {
    throw new ArchiveSecurityError('HAYBA-ARCHIVE-LINK', 'reparse-point entries are forbidden');
  }
}

function inspectExtraFields(extra: Buffer): void {
  let offset = 0;
  while (offset < extra.length) {
    if (offset + 4 > extra.length) {
      throw new ArchiveSecurityError('HAYBA-ARCHIVE-TRUNCATED', 'malformed ZIP extra field');
    }
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + size > extra.length) {
      throw new ArchiveSecurityError('HAYBA-ARCHIVE-TRUNCATED', 'malformed ZIP extra field payload');
    }
    // ZIP64 changes all size/offset assumptions; NTFS and ASi Unix extras can
    // encode reparse/link metadata. Reject rather than partially understand.
    if (id === 0x0001) {
      throw new ArchiveSecurityError('HAYBA-ARCHIVE-ZIP64', 'ZIP64 archives are not accepted');
    }
    if (id === 0x000a || id === 0x000d || id === 0x5855 || id === 0x756e) {
      throw new ArchiveSecurityError('HAYBA-ARCHIVE-LINK', 'filesystem-specific link metadata is forbidden');
    }
    offset += size;
  }
}

async function findEocd(
  handle: fsp.FileHandle,
  archiveBytes: number,
  signal: AbortSignal,
): Promise<{ offset: number; record: Buffer }> {
  if (archiveBytes < EOCD_FIXED_BYTES) {
    throw new ArchiveSecurityError('HAYBA-ARCHIVE-TRUNCATED', 'file is too short to be a ZIP archive');
  }
  const tailBytes = Math.min(archiveBytes, EOCD_FIXED_BYTES + 0xffff);
  const tailOffset = archiveBytes - tailBytes;
  const tail = await readExactly(handle, tailBytes, tailOffset, signal);
  for (let i = tail.length - EOCD_FIXED_BYTES; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) !== EOCD_SIGNATURE) continue;
    const commentBytes = tail.readUInt16LE(i + 20);
    if (i + EOCD_FIXED_BYTES + commentBytes !== tail.length) continue;
    return { offset: tailOffset + i, record: tail.subarray(i, i + EOCD_FIXED_BYTES) };
  }
  throw new ArchiveSecurityError('HAYBA-ARCHIVE-TRUNCATED', 'end-of-central-directory record is missing');
}

async function inspectZip(handle: fsp.FileHandle, limits: ArchiveLimits, signal: AbortSignal): Promise<ZipPlan> {
  throwIfArchiveAborted(signal);
  const stat = await handle.stat();
  throwIfArchiveAborted(signal);
  if (!stat.isFile() || stat.size > limits.maxDownloadBytes) {
    throw new ArchiveSecurityError('HAYBA-ARCHIVE-SIZE', `archive exceeds ${limits.maxDownloadBytes} bytes`);
  }
  const archiveBytes = stat.size;
  const { offset: eocdOffset, record: eocd } = await findEocd(handle, archiveBytes, signal);
  const disk = eocd.readUInt16LE(4);
  const centralDisk = eocd.readUInt16LE(6);
  const diskEntries = eocd.readUInt16LE(8);
  const totalEntries = eocd.readUInt16LE(10);
  const centralBytes = eocd.readUInt32LE(12);
  const centralOffset = eocd.readUInt32LE(16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    throw new ArchiveSecurityError('HAYBA-ARCHIVE-MULTIDISK', 'multi-disk archives are not accepted');
  }
  if (totalEntries === ZIP64_SENTINEL_16 || centralBytes === ZIP64_SENTINEL_32 || centralOffset === ZIP64_SENTINEL_32) {
    throw new ArchiveSecurityError('HAYBA-ARCHIVE-ZIP64', 'ZIP64 archives are not accepted');
  }
  if (totalEntries > limits.maxEntries) {
    throw new ArchiveSecurityError('HAYBA-ARCHIVE-ENTRIES', `archive has more than ${limits.maxEntries} entries`);
  }
  if (centralBytes > limits.maxCentralDirectoryBytes || centralOffset + centralBytes !== eocdOffset) {
    throw new ArchiveSecurityError(
      'HAYBA-ARCHIVE-CENTRAL',
      'central directory is oversized, overlapping, or non-canonical',
    );
  }

  const entries: ZipEntry[] = [];
  const normalizedNames = new Set<string>();
  const caseFoldedNames = new Set<string>();
  const localOffsets = new Set<number>();
  let cursor = centralOffset;
  let totalUncompressedBytes = 0;

  for (let index = 0; index < totalEntries; index += 1) {
    throwIfArchiveAborted(signal);
    const fixed = await readExactly(handle, CENTRAL_FIXED_BYTES, cursor, signal);
    if (fixed.readUInt32LE(0) !== CENTRAL_SIGNATURE) {
      throw new ArchiveSecurityError(
        'HAYBA-ARCHIVE-CENTRAL',
        `entry ${index} has an invalid central-directory signature`,
      );
    }
    const versionMadeBy = fixed.readUInt16LE(4);
    const flags = fixed.readUInt16LE(8);
    const method = fixed.readUInt16LE(10);
    const crc32 = fixed.readUInt32LE(16);
    const compressedSize = fixed.readUInt32LE(20);
    const uncompressedSize = fixed.readUInt32LE(24);
    const nameBytes = fixed.readUInt16LE(28);
    const extraBytes = fixed.readUInt16LE(30);
    const commentBytes = fixed.readUInt16LE(32);
    const diskStart = fixed.readUInt16LE(34);
    const externalAttributes = fixed.readUInt32LE(38);
    const localHeaderOffset = fixed.readUInt32LE(42);
    cursor += CENTRAL_FIXED_BYTES;

    if (flags & 0x1) {
      throw new ArchiveSecurityError('HAYBA-ARCHIVE-ENCRYPTED', 'encrypted entries are not accepted');
    }
    if (flags & 0x40) {
      throw new ArchiveSecurityError('HAYBA-ARCHIVE-ENCRYPTED', 'strongly encrypted entries are not accepted');
    }
    if (method !== 0 && method !== 8) {
      throw new ArchiveSecurityError('HAYBA-ARCHIVE-METHOD', `compression method ${method} is not supported`);
    }
    if (method === 0 && compressedSize !== uncompressedSize) {
      throw new ArchiveSecurityError('HAYBA-ARCHIVE-ENTRY-SIZE', 'stored entry sizes disagree');
    }
    if (diskStart !== 0 || localHeaderOffset === ZIP64_SENTINEL_32) {
      throw new ArchiveSecurityError('HAYBA-ARCHIVE-MULTIDISK', 'split or ZIP64 entries are not accepted');
    }
    if (cursor + nameBytes + extraBytes + commentBytes > centralOffset + centralBytes) {
      throw new ArchiveSecurityError('HAYBA-ARCHIVE-TRUNCATED', 'entry metadata extends beyond the central directory');
    }
    if (nameBytes === 0 || nameBytes > limits.maxNameBytes) {
      throw new ArchiveSecurityError('HAYBA-ARCHIVE-NAME', 'entry filename exceeds its metadata ceiling');
    }
    if (extraBytes > limits.maxExtraFieldBytes) {
      throw new ArchiveSecurityError('HAYBA-ARCHIVE-METADATA', 'entry extra field exceeds its metadata ceiling');
    }
    const rawName = await readExactly(handle, nameBytes, cursor, signal);
    const extra = await readExactly(handle, extraBytes, cursor + nameBytes, signal);
    cursor += nameBytes + extraBytes + commentBytes;
    inspectExtraFields(extra);

    const safeName = rejectUnsafeName(rawName, limits);
    inspectExternalAttributes(versionMadeBy, externalAttributes, safeName.isDirectory);
    if (safeName.isDirectory && (compressedSize !== 0 || uncompressedSize !== 0)) {
      throw new ArchiveSecurityError('HAYBA-ARCHIVE-TYPE', 'directory entries must have zero sizes');
    }
    if (compressedSize > limits.maxEntryCompressedBytes || uncompressedSize > limits.maxEntryUncompressedBytes) {
      throw new ArchiveSecurityError(
        'HAYBA-ARCHIVE-ENTRY-SIZE',
        'entry exceeds its compressed or uncompressed byte ceiling',
      );
    }
    totalUncompressedBytes += uncompressedSize;
    if (!Number.isSafeInteger(totalUncompressedBytes) || totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
      throw new ArchiveSecurityError('HAYBA-ARCHIVE-TOTAL-SIZE', 'archive exceeds its total uncompressed byte ceiling');
    }
    if (
      uncompressedSize > 0 &&
      (compressedSize === 0 || uncompressedSize / compressedSize > limits.maxCompressionRatio)
    ) {
      throw new ArchiveSecurityError(
        'HAYBA-ARCHIVE-RATIO',
        `entry exceeds compression ratio ${limits.maxCompressionRatio}:1`,
      );
    }

    const normalized = safeName.segments.join('/');
    const caseFolded = normalized.toLocaleLowerCase('en-US');
    if (normalizedNames.has(normalized)) {
      throw new ArchiveSecurityError('HAYBA-ARCHIVE-DUPLICATE', 'duplicate normalized entry path');
    }
    if (caseFoldedNames.has(caseFolded)) {
      throw new ArchiveSecurityError('HAYBA-ARCHIVE-CASE-COLLISION', 'case-colliding entry paths are forbidden');
    }
    if (localOffsets.has(localHeaderOffset)) {
      throw new ArchiveSecurityError('HAYBA-ARCHIVE-DUPLICATE', 'entries alias the same local file record');
    }
    normalizedNames.add(normalized);
    caseFoldedNames.add(caseFolded);
    localOffsets.add(localHeaderOffset);

    const localFixed = await readExactly(handle, LOCAL_FIXED_BYTES, localHeaderOffset, signal);
    if (localFixed.readUInt32LE(0) !== LOCAL_SIGNATURE) {
      throw new ArchiveSecurityError('HAYBA-ARCHIVE-LOCAL', 'invalid local file header');
    }
    const localFlags = localFixed.readUInt16LE(6);
    const localMethod = localFixed.readUInt16LE(8);
    const localNameBytes = localFixed.readUInt16LE(26);
    const localExtraBytes = localFixed.readUInt16LE(28);
    if (localExtraBytes > limits.maxExtraFieldBytes) {
      throw new ArchiveSecurityError('HAYBA-ARCHIVE-METADATA', 'local extra field exceeds its metadata ceiling');
    }
    if (localFlags !== flags || localMethod !== method || localNameBytes !== rawName.length) {
      throw new ArchiveSecurityError('HAYBA-ARCHIVE-LOCAL', 'local and central entry metadata disagree');
    }
    const localName = await readExactly(handle, localNameBytes, localHeaderOffset + LOCAL_FIXED_BYTES, signal);
    if (!localName.equals(rawName)) {
      throw new ArchiveSecurityError('HAYBA-ARCHIVE-LOCAL', 'local and central filenames disagree');
    }
    const localExtra = await readExactly(
      handle,
      localExtraBytes,
      localHeaderOffset + LOCAL_FIXED_BYTES + localNameBytes,
      signal,
    );
    inspectExtraFields(localExtra);
    if ((flags & 0x8) === 0) {
      const localCrc = localFixed.readUInt32LE(14);
      const localCompressedSize = localFixed.readUInt32LE(18);
      const localUncompressedSize = localFixed.readUInt32LE(22);
      if (localCrc !== crc32 || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize) {
        throw new ArchiveSecurityError('HAYBA-ARCHIVE-LOCAL', 'local and central size/CRC metadata disagree');
      }
    }
    const dataOffset = localHeaderOffset + LOCAL_FIXED_BYTES + localNameBytes + localExtraBytes;
    if (dataOffset < 0 || dataOffset + compressedSize > centralOffset) {
      throw new ArchiveSecurityError('HAYBA-ARCHIVE-OVERLAP', 'entry data extends into archive metadata');
    }

    entries.push({
      rawName,
      ...safeName,
      flags,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      dataOffset,
    });
  }
  if (cursor !== centralOffset + centralBytes) {
    throw new ArchiveSecurityError('HAYBA-ARCHIVE-CENTRAL', 'central directory contains unparsed bytes');
  }
  if (!entries.some((entry) => !entry.isDirectory)) {
    throw new ArchiveSecurityError('HAYBA-ARCHIVE-EMPTY', 'archive contains no regular files to import');
  }
  const filePaths = new Set(entries.filter((entry) => !entry.isDirectory).map((entry) => entry.segments.join('/')));
  const filePathsFolded = new Set([...filePaths].map((file) => file.toLocaleLowerCase('en-US')));
  for (const entry of entries) {
    for (let depth = 1; depth < entry.segments.length; depth += 1) {
      const prefix = entry.segments.slice(0, depth).join('/');
      if (filePaths.has(prefix) || filePathsFolded.has(prefix.toLocaleLowerCase('en-US'))) {
        throw new ArchiveSecurityError('HAYBA-ARCHIVE-COLLISION', 'a file entry is also used as a parent directory');
      }
    }
  }
  const ranges = entries
    .map((entry) => ({ start: entry.localHeaderOffset, end: entry.dataOffset + entry.compressedSize }))
    .sort((a, b) => a.start - b.start);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index]!.start < ranges[index - 1]!.end) {
      throw new ArchiveSecurityError('HAYBA-ARCHIVE-OVERLAP', 'local entry records overlap or alias archive bytes');
    }
  }
  return { entries, archiveBytes, totalUncompressedBytes };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

class VerifyEntryTransform extends ByteLimitTransform {
  private crc = 0xffffffff;

  constructor(
    maximum: number,
    private readonly expectedBytes: number,
    private readonly expectedCrc: number,
  ) {
    super(maximum, 'HAYBA-ARCHIVE-INFLATE-SIZE');
  }

  override _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
    for (const byte of chunk) this.crc = CRC_TABLE[(this.crc ^ byte) & 0xff]! ^ (this.crc >>> 8);
    super._transform(chunk, encoding, callback);
  }

  assertComplete(): void {
    if (this.bytes !== this.expectedBytes) {
      throw new ArchiveSecurityError('HAYBA-ARCHIVE-INFLATE-SIZE', 'inflated byte count disagrees with metadata');
    }
    if ((this.crc ^ 0xffffffff) >>> 0 !== this.expectedCrc) {
      throw new ArchiveSecurityError('HAYBA-ARCHIVE-CRC', 'entry CRC does not match archive metadata');
    }
  }
}

function containedPath(root: string, segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, ...segments);
  if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new ArchiveSecurityError('HAYBA-ARCHIVE-PATH', 'resolved entry escapes the extraction root');
  }
  return candidate;
}

async function assertNoLinks(root: string, directory: string, signal: AbortSignal): Promise<void> {
  throwIfArchiveAborted(signal);
  const rootStat = await fsp.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new ArchiveSecurityError('HAYBA-ARCHIVE-LINK', 'private extraction root is not a real directory');
  }
  const relative = path.relative(root, directory);
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    throwIfArchiveAborted(signal);
    cursor = path.join(cursor, segment);
    const stat = await fsp.lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ArchiveSecurityError('HAYBA-ARCHIVE-LINK', 'extraction parent is not a real directory');
    }
  }
}

async function extractPlan(
  archiveHandle: fsp.FileHandle,
  stageRoot: string,
  plan: ZipPlan,
  limits: ArchiveLimits,
  signal: AbortSignal,
): Promise<string[]> {
  const files: string[] = [];
  for (const entry of plan.entries) {
    throwIfArchiveAborted(signal);
    const destination = containedPath(stageRoot, entry.segments);
    if (entry.isDirectory) {
      await fsp.mkdir(destination, { recursive: true, mode: 0o700 });
      await assertNoLinks(stageRoot, destination, signal);
      continue;
    }

    const parent = path.dirname(destination);
    await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
    await assertNoLinks(stageRoot, parent, signal);
    if (entry.compressedSize === 0) {
      if (entry.uncompressedSize !== 0 || entry.crc32 !== 0) {
        throw new ArchiveSecurityError('HAYBA-ARCHIVE-INFLATE-SIZE', 'empty entry metadata is inconsistent');
      }
      const handle = await fsp.open(destination, 'wx', 0o600);
      await handle.close();
      throwIfArchiveAborted(signal);
      files.push(destination);
      continue;
    }
    const source = fs.createReadStream('bound-archive-handle', {
      fd: archiveHandle.fd,
      autoClose: false,
      start: entry.dataOffset,
      end: entry.dataOffset + entry.compressedSize - 1,
    });
    const verifier = new VerifyEntryTransform(
      Math.min(entry.uncompressedSize, limits.maxEntryUncompressedBytes),
      entry.uncompressedSize,
      entry.crc32,
    );
    const output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
    if (entry.method === 8) await pipeline(source, createInflateRaw(), verifier, output, { signal });
    else await pipeline(source, verifier, output, { signal });
    throwIfArchiveAborted(signal);
    verifier.assertComplete();
    files.push(destination);
  }
  return files;
}

/**
 * Validates every entry before inflating the first byte. Extraction happens in
 * a private sibling directory and is promoted only after every CRC and size
 * check succeeds. Any rejection removes the entire stage and leaves `destDir`
 * absent and unchanged.
 */
export async function extractZip(
  zipPath: string,
  destDir: string,
  overrides?: Partial<ArchiveLimits>,
  testHooks?: ArchiveExtractionTestHooks,
): Promise<string[]> {
  const limits = checkedLimits(overrides);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('archive validation/extraction deadline exceeded')),
    limits.extractionTimeoutMs,
  );
  timeout.unref?.();
  let archiveHandle: fsp.FileHandle | undefined;
  let stageRoot: string | undefined;
  let result: string[] | undefined;
  let failure: unknown;
  let closeFailure: unknown;
  try {
    archiveHandle = await fsp.open(zipPath, 'r');
    const plan = await inspectZip(archiveHandle, limits, controller.signal);
    const parent = path.dirname(destDir);
    await fsp.mkdir(parent, { recursive: true });
    throwIfArchiveAborted(controller.signal);
    const activeStageRoot = await fsp.mkdtemp(path.join(parent, '.hayba-extract-'));
    stageRoot = activeStageRoot;
    await testHooks?.afterStageReady?.();
    throwIfArchiveAborted(controller.signal);
    const stageFiles = await extractPlan(archiveHandle, activeStageRoot, plan, limits, controller.signal);
    try {
      await fsp.lstat(destDir);
      throw new ArchiveSecurityError('HAYBA-ARCHIVE-COLLISION', 'destination already exists; refusing to overwrite it');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
    throwIfArchiveAborted(controller.signal);
    await fsp.rename(activeStageRoot, destDir);
    result = stageFiles.map((file) => path.join(destDir, path.relative(activeStageRoot, file)));
    stageRoot = undefined;
  } catch (error: unknown) {
    failure = controller.signal.aborted
      ? new ArchiveSecurityError('HAYBA-ARCHIVE-TIMEOUT', 'archive validation/extraction deadline exceeded')
      : error;
  } finally {
    clearTimeout(timeout);
    try {
      await archiveHandle?.close();
    } catch (closeError: unknown) {
      closeFailure = closeError;
    }
  }
  if (failure !== undefined) {
    if (stageRoot) failure = await cleanupAfterRefusal(failure, stageRoot);
    if (closeFailure !== undefined) {
      const retained = failure instanceof ConnectorCleanupError ? failure.retainedPaths : [];
      const primary = failure instanceof ConnectorCleanupError ? failure.primary : failure;
      failure = new ConnectorCleanupError(primary, retained, closeFailure);
    }
    throw failure;
  }
  if (closeFailure !== undefined) {
    throw new ConnectorCleanupError(
      new ArchiveSecurityError('HAYBA-ARCHIVE-CLOSE', 'archive handle cleanup failed after extraction'),
      [],
      closeFailure,
    );
  }
  return result!;
}

/**
 * One fail-closed production seam: the callback (UE import in connectors) is
 * unreachable until both download and full extraction verification succeed.
 */
export async function downloadExtractThen<T>(options: {
  url: string;
  archivePath: string;
  extractDir: string;
  headers?: Record<string, string>;
  limits?: Partial<ArchiveLimits>;
  /** Request-owned directory removed in full if download or validation fails. */
  failureCleanupRoot?: string;
  afterVerified: (files: string[]) => Promise<T>;
  testHooks?: DownloadExtractTestHooks;
}): Promise<{ files: string[]; result: T }> {
  const cleanupRoot = options.failureCleanupRoot ? path.resolve(options.failureCleanupRoot) : undefined;
  if (cleanupRoot) {
    const archive = path.resolve(options.archivePath);
    const extraction = path.resolve(options.extractDir);
    if (!archive.startsWith(`${cleanupRoot}${path.sep}`) || !extraction.startsWith(`${cleanupRoot}${path.sep}`)) {
      throw new ArchiveSecurityError(
        'HAYBA-ARCHIVE-CLEANUP-SCOPE',
        'download and extraction paths must be children of their failure cleanup root',
      );
    }
  }
  try {
    await downloadToFile(options.url, options.archivePath, options.headers, options.limits);
    const files = await extractZip(options.archivePath, options.extractDir, options.limits);
    const result = await options.afterVerified(files);
    return { files, result };
  } catch (error) {
    throw cleanupRoot
      ? await cleanupAfterRefusal(error, cleanupRoot, options.testHooks?.removeFailureCleanupRoot)
      : error;
  }
}
