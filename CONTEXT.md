# CONTEXT

Domain language and orientation for the Hayba monorepo. Read this before
making architectural changes. Architecture vocabulary (module, interface,
depth, seam, adapter) is used deliberately — keep it consistent.

## What Hayba is

An **agentic world-building toolset**. An AI agent authors Unreal Engine 5
scenes — through one
**Model Context Protocol (MCP)** connection. Spatial-first: UE is treated
as a 3D world, not a 2D code repo.

## The protocol seam (the load-bearing concept)

There is **one protocol across two language boundaries**:

```
Agent host ──stdio──▶ Node MCP server ──TCP──▶ UE5 C++ plugin
 (Claude/GPT)        (mcp-tools/hayba-mcp)    (unreal/HaybaMCPToolkit)
```

- **MCP server** — the Node/TypeScript **module** exposing the tool
  surface. Its interface is the set of MCP tools + their Zod schemas.
- **TCP seam** — length-prefixed JSON envelope `{ cmd, id, params, auth? }`
  on `:52342` (fallback `:52343-52350`). Two **adapters** sit on it:
  `mcp-tools/hayba-mcp/src/tcp-client.ts` and the UE plugin's
  `FHaybaMCPTcpServer`. They must agree on the envelope — this is the
  single most important invariant in the repo.
- **UE plugin** — the C++ editor **adapter**: 34 command-handler domains,
  Slate panels.

## Glossary

- **Handler domain** — one of 33 UE-side command groups (Actor, PCG,
  Sequencer, …), each implementing `IHaybaMCPHandler` (`GetCommands()` /
  `Handle()`).
- **Plan Mode** — every destructive op is wrapped in
  `GEditor->BeginTransaction` so `Ctrl+Z` works. A safety invariant, not a
  feature flag.
- **PCG / PCGEx** — UE Procedural Content Generation; Hayba ships a SQLite
  registry of PCGEx nodes/pins/properties queried by intent.
- **Code Mode meta-tools** — `list_tool_categories` / `get_tool_signature`
  / `python_run`: the small interface that hides the full ~100-tool
  catalog until needed (a deliberately **deep** module).
- **Visual sidecar** — Python FastAPI (CLIP/SpatialCLIP/OWL-ViT + SAM)
  for spatial grounding, physics validation, and AI mask generation;
  degraded-mode aware.
- **Re-emulation doctrine** — when a pre-restructure branch's behaviour
  must land on the restructured layout, reproduce its *effect* as fresh
  commits; never git-merge the old layout back in (see ADR-0001).

## Repo shape

`mcp-tools/` (Node MCP server + Python visual sidecar) · `unreal/`
(UE plugin) · `website/` + `supabase/` + `infra/` (web/back).

## Decisions

Architectural decisions are recorded in [`docs/adr/`](docs/adr/). Don't
re-litigate a recorded decision without reopening its ADR.

## Hard constraints

- The authoritative gate is **local**: `tsc + npm test` in
  `mcp-tools/hayba-mcp`. Run it before pushing.
- No `Co-Authored-By`/AI trailer in commits.
