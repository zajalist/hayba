// mcp-tools/hayba-mcp/src/recipes/loader.ts
//
// RecipeLoader — reads *.recipe.json from %APPDATA%/Hayba/recipes/
// (userDir). Validates with parseRecipeSpec; bad files are skipped and
// reported via errors() so the MCP server keeps booting.
//
// Bundled starter specs are NOT installed automatically. The IA calls that a
// choice -- "the optional seed choice must be explicit" -- and a library that
// fills itself also destroys the teaching empty state a fresh install is
// supposed to show. Call seedStarterRecipes() when the user asks for them;
// availableStarters() reports what is on offer.
//
// Updates to specs the user ALREADY has still happen automatically on reload.
// That is maintenance of their library, not an addition to it.
//
// "install" writes a new spec to userDir and updates the in-memory map.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { RecipeSpec } from './types.js';
import { parseRecipeSpec } from './spec-schema.js';

export interface RecipeLoaderOpts {
  /** Absolute path to %APPDATA%/Hayba/recipes/ (or test override). */
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
    // Updates only. Installing a starter the user never asked for -- or
    // re-installing one they deleted -- is not this method's business.
    this.updateInstalledFromBundled();
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

  /** Bundled specs the user does not have installed.
   *
   *  What a "seed the Library?" prompt should offer, and what the Library's
   *  empty state can mention. Empty array when nothing is bundled. */
  availableStarters(): string[] {
    return this.bundledSpecNames().filter(
      name => !existsSync(join(this.userDir, name)),
    );
  }

  /** Install the bundled starters the user does not have. Their decision.
   *
   *  Returns the ids installed. Does not touch specs already present: this is
   *  additive only, so re-running it after the user has edited a starter
   *  cannot overwrite their edit. */
  async seedStarterRecipes(): Promise<string[]> {
    this.ensureDir(this.userDir);
    const installed: string[] = [];
    for (const name of this.availableStarters()) {
      copyFileSync(join(this.bundledDir, name), join(this.userDir, name));
      installed.push(name);
    }
    if (installed.length) await this.reload();
    return installed;
  }

  /** Bring specs the user ALREADY has up to the bundled version.
   *
   *  Deliberately does not install anything new. A recipe the user deleted
   *  stays deleted -- the old combined method silently reinstalled it on the
   *  next launch, which reads as the library ignoring them. */
  private updateInstalledFromBundled(): void {
    for (const name of this.bundledSpecNames()) {
      const target = join(this.userDir, name);
      if (!existsSync(target)) continue;   // not installed: not ours to add
      const source = join(this.bundledDir, name);
      // Same version → nothing to do. A corrupt installed file reads as null
      // and so differs from any real version, which self-heals it.
      if (readSpecVersion(target) === readSpecVersion(source)) continue;
      copyFileSync(source, target);
    }
  }

  private bundledSpecNames(): string[] {
    if (!existsSync(this.bundledDir)) return [];
    if (!statSync(this.bundledDir).isDirectory()) return [];
    return readdirSync(this.bundledDir).filter(isSpecFile);
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

/** Default user dir resolver — %APPDATA%/Hayba/recipes on Windows,
 *  ~/.hayba/recipes elsewhere. */
export function defaultUserRecipesDir(): string {
  const base = process.env.APPDATA ?? join(process.env.HOME ?? '.', '.hayba');
  return join(base, 'Hayba', 'recipes');
}

/** Where the library lived before the rename. */
export function legacyUserRecipesDir(): string {
  const base = process.env.APPDATA ?? join(process.env.HOME ?? '.', '.hayba');
  return join(base, 'Hayba', 'slivers');
}

/**
 * Move a pre-rename library to its new home, once.
 *
 * The plugin reads the same directory, so both halves have to agree on where
 * it is -- point them at different paths and the user's Recipes panel goes
 * empty. Both call this before reading, and it is safe to lose that race: the
 * rename is atomic, so whichever process gets there first wins and the other
 * simply finds the destination already present.
 *
 * A rename rather than a copy, deliberately. Two live copies would drift the
 * moment anyone edited one of them, and "which of these two libraries is the
 * real one" is a worse problem than the one this solves.
 *
 * Returns what it did, so a caller can log it rather than move a user's files
 * in silence.
 */
export function migrateLegacyLibrary(
  legacyDir: string,
  userDir: string,
): { moved: boolean; reason?: string } {
  if (!existsSync(legacyDir)) return { moved: false, reason: 'no legacy library' };
  if (legacyDir === userDir) return { moved: false, reason: 'same directory' };

  if (!existsSync(userDir)) {
    try {
      renameSync(legacyDir, userDir);
      return { moved: true };
    } catch (e) {
      // Cross-volume, or a permission problem. Fall through to per-file.
      const reason = e instanceof Error ? e.message : String(e);
      if (!existsSync(userDir)) mkdirSync(userDir, { recursive: true });
      return moveSpecsIndividually(legacyDir, userDir, `rename failed: ${reason}`);
    }
  }

  // Destination already exists -- a partly-migrated install, or the plugin got
  // here first. Move over only what is missing; never overwrite.
  return moveSpecsIndividually(legacyDir, userDir);
}

function moveSpecsIndividually(
  legacyDir: string,
  userDir: string,
  note?: string,
): { moved: boolean; reason?: string } {
  let moved = 0;
  for (const name of readdirSync(legacyDir)) {
    if (!isSpecFile(name)) continue;
    const to = join(userDir, name);
    if (existsSync(to)) continue;
    try {
      renameSync(join(legacyDir, name), to);
      moved += 1;
    } catch {
      // Leave it behind rather than risk half-writing someone's spec.
    }
  }
  return { moved: moved > 0, reason: note };
}
