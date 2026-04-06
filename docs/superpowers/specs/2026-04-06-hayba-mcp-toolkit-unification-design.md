# Hayba MCP Toolkit — Unification Design

**Date:** 2026-04-06  
**Status:** Approved  
**Scope:** Spec 1 of 3 (Unification → Conventions System → Landscape Import)

---

## Problem

Two separate packages (`packages/gaea`, `packages/pcgex`) each ship an MCP server and a UE plugin. Users install two servers in Claude Desktop, see two entries in the UE Tools dropdown, and must configure two separate plugins. The split makes installation fragile, discovery confusing, and future cross-domain tools (e.g. terrain-to-foliage pipeline) impossible to express cleanly.

---

## Goal

Merge into a single package (`packages/hayba`), a single MCP server (`@hayba/mcp`), and a single UE plugin (`HaybaMCPToolkit`). All tools get a `hayba_` prefix. One install, one server, one tools menu entry.

---

## Architecture

### Package Structure

`packages/pcgex` is renamed to `packages/hayba`. All TypeScript domain code from `packages/gaea/src/` moves in as `packages/hayba/src/gaea/`. `packages/gaea` is deleted after migration.

```
packages/hayba/
  src/
    gaea/                        ← moved from packages/gaea/src/
      swarmhost.ts
      gaea-launcher.ts
      session.ts
      file-watcher.ts
      types.ts
      templates/
        index.ts
        mountains.ts
        desert.ts
        tropical.ts
        volcanic.ts
    tools/
      # PCGEx tools (renamed)
      hayba-check-ue-status.ts
      hayba-search-node-catalog.ts
      hayba-get-node-details.ts
      hayba-create-pcg-graph.ts
      hayba-validate-pcg-graph.ts
      hayba-list-pcg-assets.ts
      hayba-export-pcg-graph.ts
      hayba-execute-pcg-graph.ts
      hayba-scrape-node-registry.ts
      hayba-match-pin-names.ts
      hayba-validate-attribute-flow.ts
      hayba-diff-against-working-asset.ts
      hayba-format-graph-topology.ts
      hayba-abstract-to-subgraph.ts
      hayba-parameterize-graph-inputs.ts
      hayba-query-pcgex-docs.ts
      hayba-initiate-infrastructure-brainstorm.ts
      hayba-inject-debug-nodes.ts
      hayba-auto-wire-debug-overlay.ts
      # Gaea tools (moved + renamed)
      hayba-create-terrain.ts
      hayba-bake-terrain.ts
      hayba-open-in-gaea.ts
      hayba-read-terrain-variables.ts
      hayba-set-terrain-variables.ts
      hayba-open-session.ts
      hayba-close-session.ts
      hayba-add-node.ts
      hayba-remove-node.ts
      hayba-connect-nodes.ts
      hayba-get-graph-state.ts
      hayba-get-parameters.ts
      hayba-set-parameter.ts
      hayba-list-node-types.ts
      hayba-cook-graph.ts
      index.ts                   ← registerTools(server) — centralized registration
    tcp-client.ts                ← unchanged
    config.ts                    ← unchanged
    logger.ts                    ← unchanged
    resources.ts                 ← unchanged
    types.ts                     ← merged types
    index.ts                     ← single MCP server entry point
  tests/
    gaea/                        ← moved from packages/gaea/tests/
    tools/                       ← moved from packages/pcgex tests
    ...
  Plugins/
    HaybaMCPToolkit/             ← merged UE plugin
  Resources/                     ← unchanged (node catalog, registry db)
  package.json                   ← name: "@hayba/mcp", bin: "hayba-mcp"
  tsconfig.json
  swarmhost.config.json          ← moved from packages/gaea/
```

### Tool Registration Pattern

Both packages currently differ in how tools register themselves:
- `packages/gaea`: self-registration via `registerTool()` side-effect imports
- `packages/pcgex`: centralized `registerTools(server)` function

The unified package standardizes on **centralized registration** (pcgex's pattern). `src/tools/index.ts` exports a single `registerTools(server: McpServer)` that registers all tools — both gaea and pcgex domains — in one place.

### MCP Server Entry Point

`src/index.ts` creates a single `McpServer` instance named `hayba-mcp`, calls `registerTools(server)`, and connects via stdio. The gaea `SessionManager` is instantiated here and passed to gaea tool handlers.

### Package Metadata

`package.json`:
- `name`: `@hayba/mcp`
- `version`: `1.0.0`
- `bin`: `{ "hayba-mcp": "./dist/index.js" }`
- `description`: "Hayba MCP Toolkit — AI-powered terrain and PCG authoring for Unreal Engine"
- `engines`: `{ "node": ">=22.5.0" }`
- Dependencies: merge of both packages (add `zod`, `express`; drop `msw`, `tsx`)
- DevDependencies: unified vitest + typescript setup

---

## UE Plugin: HaybaMCPToolkit

Both UE plugins merge into a single plugin. The PCGEx TCP server side and the Gaea landscape/settings side are combined into one module.

### Plugin Descriptor (`HaybaMCPToolkit.uplugin`)

```json
{
  "FriendlyName": "Hayba MCP Toolkit",
  "Description": "AI-powered terrain and PCG authoring for Unreal Engine 5 via MCP",
  "Category": "Editor",
  "EngineVersion": "5.7.0",
  "CanContainContent": false,
  "Modules": [{ "Name": "HaybaMCPToolkit", "Type": "Editor", "LoadingPhase": "PostEngineInit" }],
  "Plugins": [
    { "Name": "PCG", "Enabled": true },
    { "Name": "Landscape", "Enabled": true }
  ]
}
```

### Source Layout

```
Plugins/HaybaMCPToolkit/
  HaybaMCPToolkit.uplugin
  Source/HaybaMCPToolkit/
    HaybaMCPToolkit.Build.cs     ← deps: PCG, Landscape, LandscapeEditor, HTTP, Json
    Public/
      HaybaMCPModule.h
      HaybaMCPCommandHandler.h
    Private/
      HaybaMCPModule.cpp         ← single "Hayba MCP Toolkit" Tools menu entry
      HaybaMCPTcpServer.cpp/h    ← from Hayba_PcgEx_MCP (TCP server, unchanged)
      HaybaMCPCommandHandler.cpp ← from Hayba_PcgEx_MCP (routes all commands)
      HaybaMCPLandscapeImporter.cpp/h  ← from HaybaGaea
      HaybaMCPSettings.cpp/h     ← merged settings: TCP port/host + output dir
      HaybaMCPPanel.cpp/h        ← single Slate panel (merges both UI widgets)
      HaybaMCPClaudeClient.cpp/h ← from Hayba_PcgEx_MCP
```

### Settings (merged)

One `UHaybaMCPSettings` class exposed in Project Settings → Plugins → Hayba MCP Toolkit:
- `TcpPort` (default: 52342) — from PCGEx
- `TcpHost` (default: 127.0.0.1) — from PCGEx
- `OutputDirectory` — from HaybaGaea (heightmap output path)

### UE Tools Menu

One entry: **Tools > Hayba MCP Toolkit** — opens the unified panel. Replaces the two separate menu entries.

---

## Tool Renaming

All tools gain the `hayba_` prefix. Full mapping:

| Old name | New name |
|---|---|
| `check_ue_status` | `hayba_check_ue_status` |
| `search_node_catalog` | `hayba_search_node_catalog` |
| `get_node_details` | `hayba_get_node_details` |
| `create_pcg_graph` | `hayba_create_pcg_graph` |
| `validate_pcg_graph` | `hayba_validate_pcg_graph` |
| `list_pcg_assets` | `hayba_list_pcg_assets` |
| `export_pcg_graph` | `hayba_export_pcg_graph` |
| `execute_pcg_graph` | `hayba_execute_pcg_graph` |
| `scrape_node_registry` | `hayba_scrape_node_registry` |
| `match_pin_names` | `hayba_match_pin_names` |
| `validate_attribute_flow` | `hayba_validate_attribute_flow` |
| `diff_against_working_asset` | `hayba_diff_against_working_asset` |
| `format_graph_topology` | `hayba_format_graph_topology` |
| `abstract_to_subgraph` | `hayba_abstract_to_subgraph` |
| `parameterize_graph_inputs` | `hayba_parameterize_graph_inputs` |
| `query_pcgex_docs` | `hayba_query_pcgex_docs` |
| `initiate_infrastructure_brainstorm` | `hayba_initiate_infrastructure_brainstorm` |
| `inject_debug_nodes` | `hayba_inject_debug_nodes` |
| `auto_wire_debug_overlay` | `hayba_auto_wire_debug_overlay` |
| `create_terrain` | `hayba_create_terrain` |
| `bake_terrain` | `hayba_bake_terrain` |
| `open_in_gaea` | `hayba_open_in_gaea` |
| `read_terrain_variables` | `hayba_read_terrain_variables` |
| `set_terrain_variables` | `hayba_set_terrain_variables` |
| `open_session` | `hayba_open_session` |
| `close_session` | `hayba_close_session` |
| `add_node` | `hayba_add_node` |
| `remove_node` | `hayba_remove_node` |
| `connect_nodes` | `hayba_connect_nodes` |
| `get_graph_state` | `hayba_get_graph_state` |
| `get_parameters` | `hayba_get_parameters` |
| `set_parameter` | `hayba_set_parameter` |
| `list_node_types` | `hayba_list_node_types` |
| `cook_graph` | `hayba_cook_graph` |

---

## Data Flow

```
Claude Desktop
  └── stdio → @hayba/mcp (single Node.js process)
                ├── Gaea domain: swarmhost.ts / SessionManager
                │     └── Gaea.Swarm.exe (subprocess)
                └── PCGEx/UE domain: tcp-client.ts
                      └── TCP :52342 → HaybaMCPToolkit (UE plugin)
                                          ├── HaybaMCPTcpServer
                                          ├── HaybaMCPCommandHandler
                                          └── HaybaMCPLandscapeImporter
```

---

## Claude Desktop Config (after migration)

```json
{
  "mcpServers": {
    "hayba-mcp": {
      "command": "npx",
      "args": ["-y", "@hayba/mcp"]
    }
  }
}
```

Replaces the two existing server entries (`hayba-gaea` + `hayba-pcgex`).

---

## GitHub README — Installation Section

```markdown
## Installation

### 1. UE Plugin
Copy `Plugins/HaybaMCPToolkit/` into your UE project's `Plugins/` folder.
Recompile the project. Enable in **Edit > Plugins > Hayba MCP Toolkit**.

### 2. MCP Server
Add to `~/.claude/claude_desktop_config.json`:

\`\`\`json
{
  "mcpServers": {
    "hayba-mcp": {
      "command": "npx",
      "args": ["-y", "@hayba/mcp"]
    }
  }
}
\`\`\`

Restart Claude Desktop. You should see **hayba-mcp** connected in the MCP panel.
```

---

## Error Handling

- Gaea tools: unchanged error handling from existing swarmhost/session code
- PCGEx/UE tools: unchanged error handling from existing tcp-client code
- No new error handling surface — this is a structural migration, not a behavior change

---

## Testing

- All existing gaea tests move to `tests/gaea/` — no changes to test logic
- All existing pcgex tests move to `tests/` root — no changes to test logic
- Tool name strings in any tests that assert on tool names are updated to `hayba_` prefix
- No new test coverage required for this spec (behavior is unchanged)

---

## Out of Scope (covered in later specs)

- UE Conventions System (Spec 2)
- `hayba_import_landscape` tool (Spec 3)
- Any new tool behavior
