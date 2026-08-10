import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { executeCommand } from '../tool-executor.js';
import { AssetVerifier } from '../asset-retriever/asset-verifier.js';
import { getDefaultRetriever } from '../asset-retriever/asset-retriever.js';
import { cleanupAfterRefusal, connectorFailureFacts } from './secure-archive.js';
export {
  cleanupAfterRefusal,
  ConnectorCleanupError,
  connectorFailureFacts,
  downloadExtractThen,
  downloadToFile,
  extractZip,
  fetchJsonBounded,
  safeDownloadLeafName,
} from './secure-archive.js';

export function connectorErrorResult(source: string, error: unknown) {
  const facts = connectorFailureFacts(error);
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            ok: false,
            source,
            error: facts.primary_error,
            ...(facts.primary_code ? { error_code: facts.primary_code } : {}),
            cleanup_failed: facts.cleanup_failed,
            retained_count: facts.retained_count,
            retained_path_refs: facts.retained_path_refs,
            ...(facts.cleanup_error ? { cleanup_error: facts.cleanup_error } : {}),
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

export interface DownloadedAsset {
  assetId: string;
  source: string;
  cachePath: string;
  files: string[];
  imported: boolean;
  importGamePath?: string;
  importNote?: string;
  /** True iff the UE asset registry confirms the import landed at importGamePath. */
  verified?: boolean;
  /** Set when verified===false; one of: not_in_registry|path_mismatch|registry_unavailable. */
  verifyReason?: string;
}

export interface AssetEnumerationLimits {
  /** Files that may be handed to a future typed import continuation. */
  maxFiles: number;
  /** Files plus directories visited. Bounds directory-only floods too. */
  maxEntries: number;
  maxDepth: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_ASSET_ENUMERATION_LIMITS: Readonly<AssetEnumerationLimits> = Object.freeze({
  maxFiles: 4_096,
  maxEntries: 8_192,
  maxDepth: 32,
  maxFileBytes: 256 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
});

export class AssetEnumerationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'AssetEnumerationError';
  }
}

export const ASSET_CONNECTOR_CACHE_ROOT = path.join(os.tmpdir(), 'hayba-asset-connectors');

function cachePathForAuthority(authorityRoot: string, source: string, assetId: string): string {
  const safeSource = source.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32) || 'source';
  const readable = assetId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || 'asset';
  const digest = createHash('sha256').update(assetId).digest('hex').slice(0, 16);
  return path.join(authorityRoot, safeSource, `${readable}-${digest}`);
}

export function cachePathFor(source: string, assetId: string): string {
  return cachePathForAuthority(ASSET_CONNECTOR_CACHE_ROOT, source, assetId);
}

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

function checkedEnumerationLimits(overrides?: Partial<AssetEnumerationLimits>): AssetEnumerationLimits {
  const limits = { ...DEFAULT_ASSET_ENUMERATION_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new AssetEnumerationError('HAYBA-ASSET-ENUM-LIMIT', `${name} must be a positive safe integer`);
    }
  }
  return limits;
}

function isConfined(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function isConfinedOrEqual(root: string, candidate: string): boolean {
  return path.resolve(root) === path.resolve(candidate) || isConfined(root, candidate);
}

interface PathIdentity {
  path: string;
  kind: 'directory' | 'file';
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

/** @internal Deterministic race seam; production connector calls never supply it. */
export interface AssetEnumerationTestHooks {
  beforeIdentityRecheck?: () => Promise<void>;
}

function normalizedNativePath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

async function requireNoPathRedirect(candidate: string): Promise<void> {
  const real = await fsp.realpath(candidate);
  if (normalizedNativePath(real) !== normalizedNativePath(path.resolve(candidate))) {
    throw new AssetEnumerationError(
      'HAYBA-ASSET-ENUM-LINK',
      'approved roots, ancestors, and entries must not traverse links or reparse redirects',
    );
  }
}

async function snapshotPath(candidate: string, kind: PathIdentity['kind']): Promise<PathIdentity> {
  const stat = await fsp.lstat(candidate, { bigint: true });
  if (stat.isSymbolicLink()) {
    throw new AssetEnumerationError('HAYBA-ASSET-ENUM-LINK', 'links and junctions are not import candidates');
  }
  if ((kind === 'directory' && !stat.isDirectory()) || (kind === 'file' && !stat.isFile())) {
    throw new AssetEnumerationError(
      kind === 'directory' ? 'HAYBA-ASSET-ENUM-ROOT' : 'HAYBA-ASSET-ENUM-TYPE',
      kind === 'directory' ? 'approved path must remain a directory' : 'only regular files may be imported',
    );
  }
  await requireNoPathRedirect(candidate);
  return {
    path: candidate,
    kind,
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return (
    left.kind === right.kind &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function recheckIdentity(snapshot: PathIdentity): Promise<void> {
  let current: PathIdentity;
  try {
    current = await snapshotPath(snapshot.path, snapshot.kind);
  } catch (error: unknown) {
    if (error instanceof AssetEnumerationError) throw error;
    throw new AssetEnumerationError('HAYBA-ASSET-ENUM-RACE', 'an enumerated path changed before final recheck');
  }
  if (!sameIdentity(snapshot, current)) {
    throw new AssetEnumerationError('HAYBA-ASSET-ENUM-RACE', 'an enumerated path changed before final recheck');
  }
}

async function recheckDirectoryObject(snapshot: PathIdentity): Promise<void> {
  let current: PathIdentity;
  try {
    current = await snapshotPath(snapshot.path, 'directory');
  } catch (error: unknown) {
    if (error instanceof AssetEnumerationError) throw error;
    throw new AssetEnumerationError('HAYBA-ASSET-ENUM-RACE', 'a cache authority path changed during setup');
  }
  // Creating the next child legitimately changes directory size, link count,
  // and timestamps. Device/inode/mode plus the canonical no-redirect check
  // discriminate replacement without mistaking our own mkdir for a race.
  if (snapshot.dev !== current.dev || snapshot.ino !== current.ino || snapshot.mode !== current.mode) {
    throw new AssetEnumerationError('HAYBA-ASSET-ENUM-RACE', 'a cache authority path changed during setup');
  }
}

async function snapshotDirectoryChain(directory: string): Promise<PathIdentity[]> {
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  const identities: PathIdentity[] = [];
  let cursor = parsed.root;
  identities.push(await snapshotPath(cursor, 'directory'));
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    identities.push(await snapshotPath(cursor, 'directory'));
  }
  return identities;
}

async function mkdirLeaf(directory: string): Promise<void> {
  try {
    await fsp.mkdir(directory, { mode: 0o700 });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
  }
}

/**
 * Establish a request-random cache directory before a connector performs any
 * network or archive write. Existing authority ancestors, the authority root,
 * and the source leaf must all be real directories with stable identities.
 *
 * Node path APIs do not provide handle-relative, no-follow authority on every
 * supported platform. A hostile post-check swap is therefore not claimed
 * impossible; the unpredictable `mkdtemp` leaf bounds exposure to this fresh
 * request. #415 owns the separate final native UE handoff and its last-moment
 * identity check.
 */
async function createUniqueCacheDirAtAuthority(
  authorityRoot: string,
  source: string,
  assetId: string,
): Promise<string> {
  const authority = path.resolve(authorityRoot);
  const parentIdentities = await snapshotDirectoryChain(path.dirname(authority));
  await mkdirLeaf(authority);
  const authorityIdentity = await snapshotPath(authority, 'directory');
  for (const identity of parentIdentities) await recheckDirectoryObject(identity);

  const prefix = cachePathForAuthority(authority, source, assetId);
  const sourceDirectory = path.dirname(prefix);
  await mkdirLeaf(sourceDirectory);
  const sourceIdentity = await snapshotPath(sourceDirectory, 'directory');
  for (const identity of [...parentIdentities, authorityIdentity]) await recheckDirectoryObject(identity);

  let requestDirectory: string | undefined;
  try {
    requestDirectory = await fsp.mkdtemp(`${prefix}-`);
    const requestIdentity = await snapshotPath(requestDirectory, 'directory');
    for (const identity of [...parentIdentities, authorityIdentity, sourceIdentity, requestIdentity]) {
      await recheckDirectoryObject(identity);
    }
    return requestDirectory;
  } catch (error: unknown) {
    if (requestDirectory) throw await cleanupAfterRefusal(error, requestDirectory);
    throw error;
  }
}

/** @internal Exercises the production authority establishment against an isolated hostile root. */
export async function createUniqueCacheDirAtAuthorityForTest(
  authorityRoot: string,
  source: string,
  assetId: string,
): Promise<string> {
  return createUniqueCacheDirAtAuthority(authorityRoot, source, assetId);
}

/** A request-owned cache root; concurrent/retried downloads never share files. */
export async function createUniqueCacheDir(source: string, assetId: string): Promise<string> {
  return createUniqueCacheDirAtAuthority(ASSET_CONNECTOR_CACHE_ROOT, source, assetId);
}

/**
 * Enumerate import candidates entirely in Node under an explicit request-owned
 * approved root. `opendir` streams entries; count/byte/depth limits are applied
 * before retaining each path. Ancestors, directories and files are checked for
 * redirects and snapshotted, then rechecked once after enumeration.
 *
 * This is a fail-closed preflight, not an OS authority grant and not a claim
 * that path races are impossible after the final check. #415 must provide a
 * brokered native authority plus a last-moment identity recheck before any UE
 * import continuation may be enabled.
 */
export async function enumerateConfinedRegularFiles(
  rootDir: string,
  approvedRootDir: string,
  overrides?: Partial<AssetEnumerationLimits>,
  testHooks?: AssetEnumerationTestHooks,
): Promise<string[]> {
  const limits = checkedEnumerationLimits(overrides);
  const root = path.resolve(rootDir);
  const approvedRoot = path.resolve(approvedRootDir);
  if (!isConfinedOrEqual(approvedRoot, root)) {
    throw new AssetEnumerationError('HAYBA-ASSET-ENUM-AUTHORITY', 'import root is outside its approved request root');
  }

  const identities: PathIdentity[] = [];
  let ancestor = approvedRoot;
  identities.push(await snapshotPath(ancestor, 'directory'));
  const relativeRoot = path.relative(approvedRoot, root);
  for (const segment of relativeRoot.split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, segment);
    identities.push(await snapshotPath(ancestor, 'directory'));
  }

  const files: string[] = [];
  const pending: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  let entriesVisited = 0;
  let totalBytes = 0n;

  while (pending.length > 0) {
    const current = pending.pop()!;
    const directory = await fsp.opendir(current.directory, { bufferSize: 16 });
    for await (const entry of directory) {
      entriesVisited += 1;
      if (entriesVisited > limits.maxEntries) {
        throw new AssetEnumerationError('HAYBA-ASSET-ENUM-ENTRIES', `tree exceeds ${limits.maxEntries} entries`);
      }

      const candidate = path.resolve(current.directory, entry.name);
      if (!isConfined(root, candidate)) {
        throw new AssetEnumerationError('HAYBA-ASSET-ENUM-CONFINEMENT', 'entry escaped the import root');
      }
      const depth = current.depth + 1;
      if (depth > limits.maxDepth) {
        throw new AssetEnumerationError('HAYBA-ASSET-ENUM-DEPTH', `entry exceeds depth ${limits.maxDepth}`);
      }

      // Never trust Dirent type alone. Snapshot the exact lexical path and its
      // canonical resolution before deciding whether it is traversable.
      const stat = await fsp.lstat(candidate, { bigint: true });
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        identities.push(await snapshotPath(candidate, 'directory'));
        pending.push({ directory: candidate, depth });
        continue;
      }
      const identity = await snapshotPath(candidate, 'file');
      if (identity.nlink !== 1n) {
        throw new AssetEnumerationError('HAYBA-ASSET-ENUM-LINK', 'multiply-linked files are not import candidates');
      }
      if (identity.size > BigInt(limits.maxFileBytes)) {
        throw new AssetEnumerationError('HAYBA-ASSET-ENUM-FILE-SIZE', `file exceeds ${limits.maxFileBytes} bytes`);
      }

      if (files.length >= limits.maxFiles) {
        throw new AssetEnumerationError('HAYBA-ASSET-ENUM-FILES', `tree exceeds ${limits.maxFiles} files`);
      }
      if (totalBytes + identity.size > BigInt(limits.maxTotalBytes)) {
        throw new AssetEnumerationError('HAYBA-ASSET-ENUM-TOTAL-SIZE', `tree exceeds ${limits.maxTotalBytes} bytes`);
      }
      files.push(candidate);
      totalBytes += identity.size;
      identities.push(identity);
    }
  }

  await testHooks?.beforeIdentityRecheck?.();
  for (const identity of identities) await recheckIdentity(identity);
  return files.sort((a, b) => a.localeCompare(b, 'en-US'));
}

/**
 * Enumerate a connector cache in Node before attempting an import.
 *
 * The current native `asset_import` command is deliberately NOT called here:
 * it accepts an unconstrained raw path, uses LoadModuleChecked, and does not
 * provide a post-import readback contract. Calling it would merely move the
 * unsafe filesystem boundary rather than close it. GitHub #415 owns the child
 * acceptance: confine each enumerated file, avoid fatal module loads, and
 * return per-file imported paths/readback before enabling the continuation.
 */
export async function importIntoUe(
  localDir: string,
  _gamePath: string,
  approvedRoot: string,
): Promise<{ ok: boolean; note?: string }> {
  if (!isConfined(ASSET_CONNECTOR_CACHE_ROOT, path.resolve(approvedRoot))) {
    throw new AssetEnumerationError(
      'HAYBA-ASSET-ENUM-AUTHORITY',
      'approved root is not a request directory below the connector cache authority',
    );
  }
  const files = await enumerateConfinedRegularFiles(localDir, approvedRoot);
  if (files.length === 0) {
    return { ok: false, note: 'HAYBA-ASSET-IMPORT-EMPTY: no bounded regular files were found' };
  }
  return {
    ok: false,
    note:
      `HAYBA-ASSET-IMPORT-TYPED-BLOCKED: ${files.length} bounded regular file snapshot(s) enumerated and rechecked in Node; ` +
      'this is not filesystem authority. Native asset_import must satisfy #415 (brokered per-file authority, final identity recheck, and post-import readback) before connectors may call it',
  };
}

/**
 * Confirm a downloaded asset actually landed in the UE asset registry, and
 * tag it stale on the default AssetRetriever so the next search delta-merges.
 * Returns `{ verified, reason? }` to populate the connector's response.
 *
 * Why: closes the silent-success hole (mcp-architectural-issues #4). The
 * pre-existing connectors returned `imported:true` whenever python_run did
 * not throw, even when the import script silently SyntaxError'd. This
 * helper insists on a registry round-trip before claiming success.
 */
export async function verifyAndMarkDelta(gamePath: string): Promise<{ verified: boolean; reason?: string }> {
  // verifyPath expects the full asset path (e.g. /Game/.../Asset.Asset). The
  // import lands files under a directory; UE's describe_assets resolution
  // returns each asset under that dir. We probe the directory by querying
  // describe_assets with a path filter and treating a non-empty response as
  // success — the verifier API is single-path so we use it for that idiom.
  const verifier = new AssetVerifier((cmd, params) => executeCommand(cmd, params ?? {}));
  // First try directory-as-path (verifier returns path_mismatch if registry
  // resolves to a child asset under that dir — treat path_mismatch as
  // "directory exists, asset(s) inside" = verified).
  const r = await verifier.verifyPath(gamePath);
  let verified = r.exists;
  let reason: string | undefined;
  if (!r.exists) {
    if (r.reason === 'path_mismatch') {
      // describe_assets returned an asset under the dir — treat as verified.
      verified = true;
    } else {
      reason = r.reason;
    }
  }
  if (verified) {
    getDefaultRetriever()?.markDeltaStale([gamePath]);
    emitAssetWrite(gamePath);
  }
  return { verified, reason };
}

// ── DAG hook ────────────────────────────────────────────────────────────────
// The DAG system registers a sink here; every verified asset write is
// forwarded as a "ue://" node so imports/generations land in the journal.
// Decoupled by a module-level sink so asset-sources keeps no DAG import.

export type AssetDagSink = (writeUri: string) => void;

let assetDagSink: AssetDagSink | null = null;

export function setAssetDagSink(sink: AssetDagSink | null): void {
  assetDagSink = sink;
}

/** Forward a verified asset write (a UE content path) to the DAG sink. */
export function emitAssetWrite(assetPath: string): void {
  if (!assetDagSink) return;
  const clean = assetPath.startsWith('/') ? assetPath.slice(1) : assetPath;
  assetDagSink(`ue://${clean}`);
}
