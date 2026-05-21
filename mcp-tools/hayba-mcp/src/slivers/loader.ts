// mcp-tools/hayba-mcp/src/slivers/loader.ts
//
// SliverLoader — reads *.sliver.json from %APPDATA%/Hayba/slivers/
// (userDir), seeding from the package's bundled specs (bundledDir) on
// first run. Validates with parseSliverSpec; bad files are skipped and
// reported via errors() so the MCP server keeps booting.
//
// "install" writes a new spec to userDir and updates the in-memory map.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SliverSpec } from './types.js';
import { parseSliverSpec } from './spec-schema.js';

export interface SliverLoaderOpts {
  /** Absolute path to %APPDATA%/Hayba/slivers/ (or test override). */
  userDir: string;
  /** Absolute path to the package's bundled specs (dist/slivers/specs/). */
  bundledDir: string;
}

export type InstallResult =
  | { ok: true; id: string; path: string }
  | { ok: false; reason: string };

const SUFFIX = '.sliver.json';

export class SliverLoader {
  private readonly userDir: string;
  private readonly bundledDir: string;
  private specs = new Map<string, SliverSpec>();
  private loadErrors: string[] = [];

  constructor(opts: SliverLoaderOpts) {
    this.userDir = opts.userDir;
    this.bundledDir = opts.bundledDir;
  }

  /** Seed (idempotent) then full reload from userDir. Call at startup or after import. */
  async reload(): Promise<void> {
    this.ensureDir(this.userDir);
    this.seedFromBundled();
    this.specs.clear();
    this.loadErrors = [];
    if (!existsSync(this.userDir)) return;
    for (const name of readdirSync(this.userDir)) {
      if (!name.endsWith(SUFFIX)) continue;
      const fullPath = join(this.userDir, name);
      try {
        const raw = readFileSync(fullPath, 'utf8');
        const json = JSON.parse(raw);
        const parsed = parseSliverSpec(json);
        if (!parsed.ok) {
          this.loadErrors.push(`${name}: ${parsed.reason}`);
          continue;
        }
        this.specs.set(parsed.spec.id, parsed.spec);
      } catch (e) {
        this.loadErrors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  list(): SliverSpec[] { return [...this.specs.values()]; }
  get(id: string): SliverSpec | undefined { return this.specs.get(id); }
  errors(): string[] { return [...this.loadErrors]; }

  install(specInput: unknown): InstallResult {
    const parsed = parseSliverSpec(specInput);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    this.ensureDir(this.userDir);
    const path = join(this.userDir, `${parsed.spec.id}${SUFFIX}`);
    writeFileSync(path, JSON.stringify(parsed.spec, null, 2));
    this.specs.set(parsed.spec.id, parsed.spec);
    return { ok: true, id: parsed.spec.id, path };
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  private seedFromBundled(): void {
    if (!existsSync(this.bundledDir)) return;
    if (!statSync(this.bundledDir).isDirectory()) return;
    for (const name of readdirSync(this.bundledDir)) {
      if (!name.endsWith(SUFFIX)) continue;
      const target = join(this.userDir, name);
      if (existsSync(target)) continue;
      copyFileSync(join(this.bundledDir, name), target);
    }
  }
}

/** Default user dir resolver — %APPDATA%/Hayba/slivers on Windows, ~/.hayba/slivers elsewhere. */
export function defaultUserSliversDir(): string {
  const base = process.env.APPDATA ?? join(process.env.HOME ?? '.', '.hayba');
  return join(base, 'Hayba', 'slivers');
}
