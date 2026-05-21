import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { executeCommand } from '../tool-executor.js';
import { AssetVerifier } from '../asset-retriever/asset-verifier.js';
import { getDefaultRetriever } from '../asset-retriever/asset-retriever.js';

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

export function cachePathFor(source: string, assetId: string): string {
  const safe = assetId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(os.tmpdir(), 'hayba-asset-connectors', source, safe);
}

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

export async function downloadToFile(url: string, dest: string, headers?: Record<string, string>): Promise<void> {
  await ensureDir(path.dirname(dest));
  const res = await fetch(url, { headers });
  if (!res.ok || !res.body) {
    throw new Error(`download failed: ${res.status} ${res.statusText} for ${url}`);
  }
  const nodeStream = Readable.fromWeb(res.body as any);
  const out = fs.createWriteStream(dest);
  await pipeline(nodeStream, out);
}

export async function extractZip(zipPath: string, destDir: string): Promise<string[]> {
  await ensureDir(destDir);
  // Lazy import — adm-zip is a CommonJS module.
  const AdmZipMod = await import('adm-zip');
  const AdmZip = (AdmZipMod as any).default ?? AdmZipMod;
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(destDir, true);
  return listFilesRecursive(destDir);
}

export async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    const entries = await fsp.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(p);
    }
  }
  if (fs.existsSync(dir)) await walk(dir);
  return out;
}

/**
 * Triggers UE import via python_run. Reaches UE only via the existing
 * python_run MCP command. If UE is not running / python_run fails, returns
 * { ok: false } and the caller surfaces it as importNote.
 */
export async function importIntoUe(localDir: string, gamePath: string): Promise<{ ok: boolean; note?: string }> {
  const normalized = localDir.replace(/\\/g, '/');
  const dest = gamePath.startsWith('/Game/') ? gamePath : `/Game/AssetConnectors/${gamePath}`;
  // python_run accepts a single statement only, so wrap the whole body in exec(...).
  // One AssetImportTask per file (UE5.7 chokes on a single task with many filenames).
  // save=False — the user can save when ready; saving inline on a fresh import burst
  // has crashed UE in practice when stacked on top of other heavy work.
  const body = [
    'import os',
    'import unreal',
    `src_dir = r"${normalized}"`,
    `dest_path = "${dest}"`,
    'files = []',
    'for root, _dirs, fnames in os.walk(src_dir):',
    '    for fn in fnames:',
    '        files.append(os.path.join(root, fn))',
    'asset_tools = unreal.AssetToolsHelpers.get_asset_tools()',
    'tasks = []',
    'for f in files:',
    '    t = unreal.AssetImportTask()',
    '    t.filename = f',
    '    t.destination_path = dest_path',
    '    t.automated = True',
    '    t.save = False',
    '    t.replace_existing = True',
    '    tasks.append(t)',
    'if tasks:',
    '    asset_tools.import_asset_tasks(tasks)',
    `unreal.log("HAYBA_IMPORT_RESULT: imported %d file(s) to %s" % (len(tasks), dest_path))`,
  ].join('\n');
  const script = `exec(${JSON.stringify(body)})`;

  try {
    const data = await executeCommand('python_run', { script });
    if (data && typeof data === 'object' && (data as any).ok === false) {
      return { ok: false, note: JSON.stringify(data).slice(0, 280) };
    }
    return { ok: true, note: typeof data === 'object' && data ? JSON.stringify(data).slice(0, 240) : undefined };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, note: `python_run unavailable: ${msg}` };
  }
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
export async function verifyAndMarkDelta(
  gamePath: string,
): Promise<{ verified: boolean; reason?: string }> {
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
  }
  return { verified, reason };
}
