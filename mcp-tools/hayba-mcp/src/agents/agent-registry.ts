/**
 * Loader for `hayba.agents.json` — the swarm-agent "archetype" manifest.
 *
 * Restores the piece described (but not implemented) by
 * docs/getting-started-swarm-agents.md: something that actually reads the
 * file, validates it, and lets an archetype id resolve to its
 * `tool_filter` / `system_prompt`. See issue #356.
 *
 * Deliberately does NOT re-implement glob matching — `buildToolCatalog`
 * (src/chat/agent-loop.ts) already owns that, so a resolved archetype's
 * `tool_filter` is handed to it unchanged as `archetypeFilter`. Two copies
 * of a glob matcher is exactly the "drifted duplicate" class of bug this
 * codebase keeps finding (docs/WORKFLOW-improving-the-mcp.md, step 2).
 *
 * Also deliberately does NOT open a HaybaMemory instance from
 * `shared_memory` — that plumbing is issue #355's concern
 * (src/tools/memory/store.ts already owns the one live memory-store
 * singleton via `config.memoryDbPath`); wiring `shared_memory` to it would
 * be a second, competing way to pick that path.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ZodIssue } from 'zod';
import { AgentsManifestSchema, type AgentsManifest, type ArchetypeConfig } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** `<package root>/hayba.agents.json` — dist/agents/ -> dist -> package root. */
export function defaultManifestPath(): string {
  return resolve(__dirname, '..', '..', 'hayba.agents.json');
}

function formatIssues(issues: ZodIssue[]): string {
  return issues
    .map((iss) => {
      const path = iss.path.length > 0 ? iss.path.join('.') : '(root)';
      return `  - ${path}: ${iss.message}`;
    })
    .join('\n');
}

/**
 * Parse and validate a manifest file at `manifestPath`. Throws a specific,
 * loud `Error` — naming the file, the failing field(s), and what was
 * expected — on any of: missing file, unreadable file, invalid JSON, or a
 * schema violation. There is no fallback value; a caller that wants one
 * must catch and decide, explicitly, rather than getting silence.
 */
export function loadAgentsManifest(manifestPath: string = defaultManifestPath()): AgentsManifest {
  if (!existsSync(manifestPath)) {
    throw new Error(
      `hayba.agents.json not found at "${manifestPath}" — the archetype loader requires ` +
        'this file to exist (see docs/getting-started-swarm-agents.md). It is not optional ' +
        'config with a silent no-archetypes fallback.',
    );
  }

  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf-8');
  } catch (e: unknown) {
    throw new Error(
      `hayba.agents.json at "${manifestPath}" could not be read: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e: unknown) {
    throw new Error(
      `hayba.agents.json at "${manifestPath}" is not valid JSON: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const result = AgentsManifestSchema.safeParse(json);
  if (!result.success) {
    throw new Error(
      `hayba.agents.json at "${manifestPath}" failed schema validation:\n` +
        formatIssues(result.error.issues),
    );
  }

  const seen = new Set<string>();
  for (const a of result.data.archetypes) {
    if (seen.has(a.id)) {
      throw new Error(
        `hayba.agents.json at "${manifestPath}" declares archetype id "${a.id}" more than ` +
          'once — archetype ids must be unique.',
      );
    }
    seen.add(a.id);
  }

  return result.data;
}

// ---------------------------------------------------------------------------
// Process-wide cache — the file is read once, not on every archetype lookup.
// ---------------------------------------------------------------------------

let cache: { path: string; manifest: AgentsManifest } | null = null;

/** Cached `loadAgentsManifest`. Same failure behaviour — nothing is swallowed. */
export function getAgentsManifest(manifestPath: string = defaultManifestPath()): AgentsManifest {
  if (cache && cache.path === manifestPath) return cache.manifest;
  const manifest = loadAgentsManifest(manifestPath);
  cache = { path: manifestPath, manifest };
  return manifest;
}

/** Test-only: drop the cache so the next call re-reads the file. */
export function __resetAgentsManifestCacheForTests(): void {
  cache = null;
}

/**
 * Resolve an archetype id to its config. Throws a specific error naming the
 * unknown id and listing the ids that ARE known, rather than returning
 * undefined for a caller to forget to check.
 */
export function getArchetype(
  id: string,
  manifestPath: string = defaultManifestPath(),
): ArchetypeConfig {
  const manifest = getAgentsManifest(manifestPath);
  const found = manifest.archetypes.find((a) => a.id === id);
  if (!found) {
    const known = manifest.archetypes.map((a) => a.id).join(', ');
    throw new Error(`unknown archetype id "${id}" — known archetype ids: ${known}`);
  }
  return found;
}

export type { ArchetypeConfig, AgentsManifest } from './types.js';
