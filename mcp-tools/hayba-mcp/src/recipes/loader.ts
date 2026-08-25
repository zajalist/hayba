// mcp-tools/hayba-mcp/src/recipes/loader.ts
//
// RecipeLoader — reads *.recipe.json from %APPDATA%/Hayba/slivers/
// (userDir), seeding from the package's bundled specs (bundledDir) on
// first run. Validates with parseRecipeSpec; bad files are skipped and
// reported via errors() so the MCP server keeps booting.
//
// "install" writes a new spec to userDir and updates the in-memory map.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RecipeSpec } from './types.js';
import { parseRecipeSpec } from './spec-schema.js';

export interface RecipeLoaderOpts {
  /** Absolute path to %APPDATA%/Hayba/slivers/ (or test override). */
  userDir: string;
  /** Absolute path to the package's bundled specs (dist/recipes/specs/). */
  bundledDir: string;
}

export type InstallResult =
  | { ok: true; id: string; path: string }
  | { ok: false; reason: string };

const SUFFIX = '.recipe.json';

/** Recipes were called slivers, and specs users already have on disk are named
 *  for that. They keep loading: only the name changed, not the format. New
 *  specs are written with SUFFIX, so a directory converts itself as it is used
 *  rather than needing a migration step. */
const LEGACY_SUFFIX = '.sliver.json';

function isSpecFile(name: string): boolean {
  return name.endsWith(SUFFIX) || name.endsWith(LEGACY_SUFFIX);
}

export class RecipeLoader {
  private readonly userDir: string;
  private readonly bundledDir: string;
  private specs = new Map<string, RecipeSpec>();
  private loadErrors: string[] = [];

  constructor(opts: RecipeLoaderOpts) {
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

    // A library part-way through the rename holds both spellings of the same
    // recipe. The map would keep whichever readdir happened to return last,
    // which is not a decision anyone made -- so read the current spelling
    // first and let it win explicitly.
    const names = readdirSync(this.userDir)
      .filter(isSpecFile)
      .sort((a, b) => Number(a.endsWith(LEGACY_SUFFIX)) - Number(b.endsWith(LEGACY_SUFFIX)));

    const claimed = new Set<string>();
    for (const name of names) {
      const fullPath = join(this.userDir, name);
      try {
        const raw = readFileSync(fullPath, 'utf8');
        const json = JSON.parse(raw);
        const parsed = parseRecipeSpec(json);
        if (!parsed.ok) {
          this.loadErrors.push(`${name}: ${parsed.reason}`);
          continue;
        }
        if (claimed.has(parsed.spec.id)) continue;
        claimed.add(parsed.spec.id);
        this.specs.set(parsed.spec.id, parsed.spec);
      } catch (e) {
        this.loadErrors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  list(): RecipeSpec[] { return [...this.specs.values()]; }
  get(id: string): RecipeSpec | undefined { return this.specs.get(id); }
  errors(): string[] { return [...this.loadErrors]; }

  install(specInput: unknown): InstallResult {
    const parsed = parseRecipeSpec(specInput);
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
      if (!isSpecFile(name)) continue;
      const source = join(this.bundledDir, name);
      const target = join(this.userDir, name);
      // Absent → seed. Present → re-seed only when the bundled spec's
      // version differs from the installed copy, so shipped updates to
      // core recipes reach existing installs. A corrupt installed file
      // (version unreadable) is also re-seeded, self-healing it.
      if (existsSync(target) && readSpecVersion(target) === readSpecVersion(source)) continue;
      copyFileSync(source, target);
    }
  }
}

/** Best-effort read of a spec file's `version` field; null if unreadable. */
function readSpecVersion(path: string): string | null {
  try {
    const v = (JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** Default user dir resolver — %APPDATA%/Hayba/slivers on Windows,
 *  ~/.hayba/slivers elsewhere.
 *
 *  The directory still carries the old name on purpose. HaybaSliverLoader.h
 *  reads the same path, and a TypeScript-only release ships without a plugin
 *  rebuild -- renaming it here would point the two halves at different
 *  directories and empty the user's Recipes panel. It moves in the same
 *  commit that rebuilds the plugin, with a one-time migration. */
export function defaultUserRecipesDir(): string {
  const base = process.env.APPDATA ?? join(process.env.HOME ?? '.', '.hayba');
  return join(base, 'Hayba', 'slivers');
}
