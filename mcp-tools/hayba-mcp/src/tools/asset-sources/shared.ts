import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { executeCommand } from '../tool-executor.js';

export interface DownloadedAsset {
  assetId: string;
  source: string;
  cachePath: string;
  files: string[];
  imported: boolean;
  importGamePath?: string;
  importNote?: string;
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
