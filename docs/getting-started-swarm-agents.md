# Getting started — Swarm agents (archetypes)

Sibling of [`docs/getting-started.md`](getting-started.md). Covers the
multi-agent "archetype" concept referenced by the in-editor onboarding
wizard and by `mcp-tools/hayba-mcp/hayba.agents.json`.

**Status up front:** the manifest is validated and loaded at runtime. Pass an
archetype id to `POST /chat/stream` and Hayba applies that archetype's system
prompt and default tool filter. An explicit `archetype_filter` still overrides
the manifest's filter for that request.

## The config file and its schema

`mcp-tools/hayba-mcp/hayba.agents.json` — a single file, checked into the
repo, not templated per project:

```json
{
  "version": 1,
  "shared_memory": "hayba-memory.db",
  "archetypes": [
    { "id": "director", "role": "Director", "tool_filter": ["*"], "memory_scope": "shared", ... },
    { "id": "asset-manager", "role": "Asset Manager", "tool_filter": ["asset_*", "scene_*", "mesh_*", "texture_*", "material_*"], "memory_scope": "shared", ... },
    { "id": "pattern-expert", "role": "Pattern Expert", "tool_filter": ["scene_*", "level_*", "pcg_*", "wp_*", "spline_*"], "memory_scope": "shared", ... },
    { "id": "node-expert", "role": "Node Expert", "tool_filter": ["docs_*", "pcg_*", "python_*"], "memory_scope": "shared", ... },
    { "id": "blueprint-generator", "role": "Blueprint Generator", "tool_filter": ["*"], "memory_scope": "private+shared", ... }
  ]
}
```

(Trimmed for space — each archetype also carries a `system_prompt` string.
See the file itself for the full text.)

The matching TypeScript type is
[`mcp-tools/hayba-mcp/src/agents/types.ts`](../mcp-tools/hayba-mcp/src/agents/types.ts):

```ts
export const ArchetypeConfigSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  system_prompt: z.string().min(1),
  tool_filter: z.array(z.string().min(1)).min(1),
  memory_scope: z.enum(['private', 'shared', 'private+shared']),
});
```

The onboarding wizard describes the file to new users as user-editable:

> "hayba.agents.json defines specialist roles (Director, Asset Manager,
> Pattern Expert, Node Expert, Blueprint Generator). Edit it to customize
> tool filters and system prompts."
> — `HaybaMCPOnboardingWidget.cpp`

## Runtime wiring

[`agent-registry.ts`](../mcp-tools/hayba-mcp/src/agents/agent-registry.ts)
loads and validates `hayba.agents.json`, caches the parsed manifest, rejects
duplicate or unknown ids, and reports malformed fields with their file path.
`POST /chat/stream`
(`mcp-tools/hayba-mcp/src/chat/chat-server.ts`) takes an optional
`archetype: string` id. It applies that entry's `system_prompt` and threads
its `tool_filter` through `runAgentLoop` → `buildToolCatalog` in
[`mcp-tools/hayba-mcp/src/chat/agent-loop.ts`](../mcp-tools/hayba-mcp/src/chat/agent-loop.ts):

```ts
export interface ToolCatalogOptions {
  disabledTools?: Iterable<string>;
  /** Archetype `tool_filter` globs (agent-registry.ts). Omit = allow all. */
  archetypeFilter?: string[];
  ...
}
```

`buildToolCatalog` glob-matches (`*` only) every name against the tool
registry and only offers the LLM the tools that pass, in addition to
whatever the disabled-tools list already excludes. This is the real,
tested mechanism — see `agent-loop.test.ts`, `'filters by archetype
tool_filter and disabled list'`.

Example request body:

```json
{ "prompt": "Audit this level", "archetype": "director" }
```

For compatibility, callers may instead pass `archetype_filter: string[]`.
When both fields are present, the explicit filter wins while the selected
archetype's system prompt still applies. `memory_scope` is validated metadata;
callers remain responsible for choosing the matching scope on `memory_*` tools.
The manifest's `shared_memory` field does not redirect the store; configure the
database with `HAYBA_MEMORY_DB` as described in the memory guide.

## A separate, actually-wired gating mechanism: disabled tools

Distinct from archetypes, but easy to confuse with them: the MCP panel's
"capability gating" UI writes to `FHaybaMCPSettings::DisabledTools`
(`HaybaMCPSettings.h`/`.cpp`), which is persisted both to the project `.ini`
and to `Saved/HaybaMCP/disabled-tools.json`. The Node MCP server watches
that JSON file and hides/rejects matching tool names
(`list_tool_categories`, `get_tool_signature`, and the `tool_disabled`
error). This one works out of the box, per-project, with no manual API
calls — but it disables tools globally for every session, not per
archetype.

## Bottom line

Use `archetype` for the shipped role configuration and `archetype_filter` for
one-off filtering. Editing the checked-in manifest changes subsequent process
loads; restart the Node server after editing because the registry is cached.
