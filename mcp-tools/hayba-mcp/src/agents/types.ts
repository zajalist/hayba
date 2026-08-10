import { z } from 'zod';

/**
 * Schema for `hayba.agents.json` (the swarm-agent "archetype" manifest —
 * see docs/getting-started-swarm-agents.md).
 *
 * Validated with zod, like the rest of this codebase, so a malformed or
 * schema-violating file fails LOUDLY — naming the file and the offending
 * field — instead of silently falling back to "no archetypes". A silent
 * fallback here would look identical to the bug this file exists to fix
 * (see issue #356 and docs/WORKFLOW-improving-the-mcp.md, "the one thing to
 * internalise": a response/state that claims success while doing nothing).
 *
 * `memory_scope` deliberately reuses the SAME 'private' | 'shared'
 * vocabulary as the memory_* tools (src/tools/memory/*.ts — see
 * `memory_write`'s `scope` param and `MemoryBlock.scope`) rather than
 * inventing a parallel notion. `'private+shared'` means the archetype may
 * read/write either scope.
 */
export const ArchetypeConfigSchema = z.object({
  id: z.string().min(1, 'id must be a non-empty string'),
  role: z.string().min(1, 'role must be a non-empty string'),
  system_prompt: z.string().min(1, 'system_prompt must be a non-empty string'),
  tool_filter: z
    .array(z.string().min(1, 'tool_filter entries must be non-empty strings'))
    .min(1, 'tool_filter must contain at least one glob pattern'),
  memory_scope: z.enum(['private', 'shared', 'private+shared']),
});

export const AgentsManifestSchema = z.object({
  version: z.number(),
  /** Filename for the shared memory DB (relative to project root). See
   *  docs/getting-started-memory-system.md — the memory_* tools resolve
   *  their own db path via config.memoryDbPath; this field is metadata
   *  about the manifest, not currently consumed to redirect that store. */
  shared_memory: z.string().min(1, 'shared_memory must be a non-empty string'),
  archetypes: z
    .array(ArchetypeConfigSchema)
    .min(1, 'archetypes must contain at least one entry'),
});

export type ArchetypeConfig = z.infer<typeof ArchetypeConfigSchema>;
export type AgentsManifest = z.infer<typeof AgentsManifestSchema>;
