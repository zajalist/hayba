# CONTEXT

Domain language and orientation for the Hayba monorepo. Read this before
making architectural changes. Architecture vocabulary (module, interface,
depth, seam, adapter) is used deliberately — keep it consistent.

## What Hayba is

An **agentic world-building toolset**. An AI agent authors Unreal Engine 5
scenes — and worlds (languages, planets, architecture) — through one
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
- **Visual sidecar** — Python FastAPI (CLIP/SpatialCLIP/OWL-ViT) for
  spatial grounding & physics validation; degraded-mode aware.
- **Worldbuilding packages** — deterministic libraries: `linguistics`
  (conlang/phonology), `planet-physics`, `architecture` (cultures).
- **Conlang workbench** — the interactive linguistics UI. Currently a
  website route placeholder; destined to live inside **Hayba Explorer**
  (see ADR-0003).
- **Hayba Explorer** — the Tauri desktop app (`apps/hayba-explorer`); the
  long-term viewer.
- **Re-emulation doctrine** — when a pre-restructure branch's behaviour
  must land on the restructured layout, reproduce its *effect* as fresh
  commits; never git-merge the old layout back in (see ADR-0001).

## Repo shape

`mcp-tools/` (Node servers) · `unreal/` (UE plugin) ·
`apps/hayba-explorer` (+ its worldbuilding `packages/*`) ·
`packages/` (shared libs) · `website/` + `supabase/` + `infra/` (web/back).

## Decisions

Architectural decisions are recorded in [`docs/adr/`](docs/adr/). Don't
re-litigate a recorded decision without reopening its ADR.

## Hard constraints

- GitHub Actions is **non-functional repo-wide**; the authoritative gate
  is local (`build @hayba/* deps → tsc + npm test` in
  `mcp-tools/hayba-mcp`). See ADR-0005.
- Tectonic plate-sim work is out of scope for current initiatives.
- No `Co-Authored-By`/AI trailer in commits.
