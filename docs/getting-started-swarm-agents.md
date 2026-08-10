# Getting started — Swarm agents (archetypes)

Sibling of [`docs/getting-started.md`](getting-started.md). Covers the
multi-agent "archetype" concept referenced by the in-editor onboarding
wizard and by `mcp-tools/hayba-mcp/hayba.agents.json`.

**Read this whole page before relying on archetypes for anything.** The
config file and its schema exist and are real; the loader that was supposed
to read the file at runtime does not currently exist in this repo. What
*is* wired up is a lower-level mechanism you drive by hand.

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
export interface ArchetypeConfig {
  id: string;
  role: string;
  system_prompt: string;
  tool_filter: string[];          // glob patterns: "*", "actor_*", "scene_*"
  memory_scope: 'shared' | 'private+shared';
}

export interface AgentsManifest {
  version: number;
  shared_memory: string;          // filename for HaybaMemory db (relative to project root)
  archetypes: ArchetypeConfig[];
}
```

The onboarding wizard describes the file to new users as user-editable:

> "hayba.agents.json defines specialist roles (Director, Asset Manager,
> Pattern Expert, Node Expert, Blueprint Generator). Edit it to customize
> tool filters and system prompts."
> — `HaybaMCPOnboardingWidget.cpp`

## What is NOT wired up

Nothing in this repository currently loads `hayba.agents.json`. There is no
`AgentRegistry` class, no `agent-registry.ts`, no C++ code that opens the
file. A comment in `mcp-tools/hayba-mcp/vitest.config.ts` documents that an
earlier version of the test suite carried an `agent-registry` test entry
"for source that no longer exists" — i.e. the loader was built at one point
(the v0.3.0 entry in `CHANGELOG.md` describes it: "`AgentRegistry` — loads
`hayba.agents.json`, instantiates per-archetype runtimes with glob
`tool_filter` matching") and has since been removed.

Concretely: `system_prompt` and `memory_scope` in the file are not consumed
by any code path found in this repo. `shared_memory` is likewise not read —
see [Getting started — Memory system](getting-started-memory-system.md) for
why the SQLite layer it's meant to point at isn't reachable either.

## What is actually wired up

The chat API accepts a raw glob list per request — it does not read the
archetype file at all. `POST /chat/stream`
(`mcp-tools/hayba-mcp/src/chat/chat-server.ts`) takes an optional
`archetype_filter: string[]` field in the request body and threads it
through to `runAgentLoop` → `buildToolCatalog` in
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

**So today, "configuring an archetype per project" means:** copy the
`tool_filter` array for the archetype you want out of `hayba.agents.json`
by hand, and pass it as `archetype_filter` in the `POST /chat/stream` body
yourself (or wire up a client that does this — none of the shipped UE panel
code does it, as far as this search found). Editing `hayba.agents.json`
alone changes nothing at runtime.

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

If your workflow needs distinct tool subsets per agent role today, drive
`archetype_filter` directly against `/chat/stream`. If you want a durable,
per-project on-disk config that a client automatically honours, that piece
(the archetype loader) is not implemented — treat `hayba.agents.json` as
documentation of an intended shape, not a working config file.
