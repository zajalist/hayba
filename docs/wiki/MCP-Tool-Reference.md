# MCP Tool Reference

This page explains **how** to discover the tool surface — it deliberately
does not enumerate every tool, because the catalog is derived at runtime, not
maintained by hand.

## The surface is derived from Zod schemas

Each tool registers a Zod schema. At registration time
(`mcp-tools/hayba-mcp/src/tools/index.ts`) the server also calls
`recordSchema(...)` into the schema registry
(`src/tools/schema-registry.ts`). `get_tool_signature` then **derives** a
command's parameter documentation by walking that exact Zod shape — so the
documented signature can never drift from the schema used to validate
inputs. There is no hand-maintained tool dictionary.

## Discovery is runtime, via Code Mode

By default the server exposes only **3 meta-tools**:

- **`list_tool_categories`** — enumerates the domains and their command
  names (filters out tools disabled in the MCP panel).
- **`get_tool_signature`** — returns the derived JSON schema for one
  command, with a "did you mean" hint on a miss.
- **`python_run`** — escape hatch into UE's `PythonScriptPlugin` for
  anything not covered by a typed command.

The full ~100-tool catalog is only registered eagerly when
`HAYBA_CODE_MODE=off`. To know what exists at any moment, call
`list_tool_categories` against the running server — that is the source of
truth, not this page.

## UE-side handler domains

The agent-facing commands are executed by the UE plugin's command handlers.
There is one `*Handler.cpp` per domain in
`unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/` — **33
concrete handler files**:

`Actor` · `Animation` · `Asset` · `Audio` · `BehaviorTree` · `Blueprint` ·
`Build` · `DataAsset` · `Docs` · `Editor` · `Foliage` · `GAS` · `ISM` ·
`Input` · `Legacy` · `Level` · `Material` · `MetaSound` · `Network` ·
`Niagara` · `PIE` · `Perf` · `Physics` · `Project` · `Python` ·
`SceneGraph` · `Sequencer` · `Spline` · `StaticMesh` · `Test` · `Texture` ·
`UI` · `WorldPartition`

The repo refers to **"34 command-handler domains"** (CONTEXT.md, root
README, the UE plugin README) — the count is the framing used across the
docs; the 33 files above are the concrete `IHaybaMCPHandler`
implementations dispatched by `HaybaMCPModule`. Each implements
`GetCommands()` / `Handle()`.

> The Node-side `list_tool_categories` groups commands into agent-facing
> categories (e.g. `actor`, `pcg`, `seq`) that map onto these handlers plus
> Node-only meta tools. Treat the running server's
> `list_tool_categories` output as authoritative for command names.

See also: [UE-Plugin](UE-Plugin.md), [Architecture](Architecture.md),
[`../../mcp-tools/hayba-mcp/README.md`](../../mcp-tools/hayba-mcp/README.md).
