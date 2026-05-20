<div align="center">

# Hayba

**The agentic engine for spatial and procedural world-building in Unreal Engine 5 — plus the worldbuilding packages, desktop explorer, and web front-end around it.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![UE 5.7](https://img.shields.io/badge/Unreal_Engine-5.7-blue.svg)](https://www.unrealengine.com/)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-✓-7A8AB8.svg)](https://modelcontextprotocol.io)
[![Tools](https://img.shields.io/badge/Tools-100+_across_33_domains-green.svg)](#features)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.5-339933.svg)](.nvmrc)

</div>

---

Hayba lets your AI agent (Claude / GPT / any MCP host) author UE5 scenes directly: spawn actors, build PCG graphs, validate physics, generate terrain, run sandboxed Python, and more — over a single MCP connection. **Spatial-first**: where every other MCP server treats UE as a 2D code repository, Hayba ships a PCG SQLite registry, a native 2D Slate cognitive map, and a SpatialCLIP visual grounding sidecar.

This is a **monorepo**: the MCP server, the UE5 C++ plugin, the Tauri desktop explorer, the worldbuilding libraries, and the public website all live here.

## Features

- **100+ tools across 33 domains** — Actor / Level / Scene / Asset / Blueprint / Material / Foliage / Spline / World Partition / ISM / Physics / Python / Editor / Docs / PCG / Sequencer / Animation / Niagara / Audio / MetaSound / GAS / Behavior Tree / Input / UI / Net / Mesh / Texture / Data / Project / Build / Test / Memory / Plan / Conventions
- **PCG SQLite registry** — 344 PCGEx nodes / 356 pins / 2270 properties scraped from C++ headers, queryable with semantic + structural intent
- **Cognitive Map** — 2D top-down semantic clustering of every actor in the level, force-directed mindmap renderer
- **Visual sidecar** — FastAPI + CLIP / SpatialCLIP / OWL-ViT for deep physics validation and spatial grounding
- **Plan Mode + native transactions** — every destructive AI op wrapped in `GEditor->BeginTransaction` so Ctrl+Z just works
- **Code Mode meta-tools** — 3 tools (`list_tool_categories` / `get_tool_signature` / `python_run`) reduce initial payload by 92%, full catalog discovered on demand
- **Worldbuilding packages** — deterministic linguistics (conlang/phonology), planet physics (habitability, tidal locking), procedural architecture (cultures, style schema)
- **Multi-instance safe** — dynamic port allocation (52342-52350) + heartbeat registry so multiple UE instances coexist

## Repository layout

| Path | What it is |
|---|---|
| [`mcp-tools/hayba-mcp`](mcp-tools/hayba-mcp) | **Core product** — the Node/TypeScript MCP server (tool surface, schema registry, TCP client to UE) |
| [`mcp-tools/hayba-mcp/addons/visual-embeddings`](mcp-tools/hayba-mcp/addons/visual-embeddings) | Python FastAPI visual sidecar (CLIP / SpatialCLIP / OWL-ViT) |
| [`mcp-tools/gaea-server`](mcp-tools/gaea-server) | TCP bridge between UE5 and Gaea terrain generation |
| `mcp-tools/gaea` · `mcp-tools/pcgex` | Locator / parked supporting tooling (see their READMEs) |
| [`unreal/HaybaMCPToolkit`](unreal/HaybaMCPToolkit) | The UE5 C++ editor plugin — 33 command-handler domains, Slate panels, the TCP server half of the protocol |
| [`apps/hayba-explorer`](apps/hayba-explorer) | Tauri + React + Rust desktop explorer (the long-term viewer) |
| `apps/hayba-explorer/packages/*` | Worldbuilding libs consumed by the explorer: `linguistics`, `planet-physics`, `tectonics`, `frame-stream`, `seeds`, `fixedpoint` |
| [`packages/architecture`](packages/architecture) | Procedural architecture engine (cultures, style schema, validation) |
| `packages/design-tokens` | Shared design tokens |
| [`website/`](website) | Public website (static HTML/CSS/JS) — landing, waitlist, login, admin |
| `infra/`, `supabase/` | Self-host infra (docker-compose, Caddy, Cloudflare tunnel) + Supabase backend (auth, migrations, edge functions) |

## Quick start

### 1. Install the UE plugin

Copy [`unreal/HaybaMCPToolkit/`](unreal/HaybaMCPToolkit) into your UE project's `Plugins/` folder, regenerate Visual Studio project files, recompile (UE 5.7+, VS 2022).

### 2. Register the MCP server with your agent host

```bash
# Claude Code
claude mcp add hayba-toolkit -- node /path/to/hayba/mcp-tools/hayba-mcp/dist/index.js
```

```jsonc
// Claude Desktop — claude_desktop_config.json
{
  "mcpServers": {
    "hayba-toolkit": {
      "command": "node",
      "args": ["/path/to/hayba/mcp-tools/hayba-mcp/dist/index.js"]
    }
  }
}
```

### 3. Run the editor

Open UE; the **Hayba MCP Toolkit** panel appears in the toolbar. Pick **Integrated** (your MCP host drives the agent) or **API Key** (in-editor chat drives Anthropic/OpenAI directly).

Then ask Claude: *"Search the PCG node catalog for voronoi, propose a 3-step plan to author a Voronoi graph, and execute it after I approve."*

## Architecture

```
┌──────────────────┐  stdio  ┌──────────────────┐  TCP   ┌────────────────┐
│  Agent Host      │ ◄────►  │  Node MCP Server │ ◄────► │  UE5 Plugin    │
│  (Claude / GPT)  │         │  mcp-tools/      │ :52342 │  unreal/       │
└──────────────────┘         │  hayba-mcp       │        │  HaybaMCP...   │
                             │  Zod · PCGEx DB  │        │  33 handlers   │
                             └──────────────────┘        └────────────────┘
```

Two language boundaries, one protocol. The TCP envelope on `:52342` (auto-fallback `:52343-52350`) carries length-prefixed JSON. Plan Mode + the editor transaction system gate every destructive op. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`CONTEXT.md`](CONTEXT.md).

## Documentation

- **[CONTEXT.md](CONTEXT.md)** — domain glossary + repo philosophy (read this first)
- **[Architecture](docs/ARCHITECTURE.md)** — language boundaries, the TCP seam, data flows
- **[Getting started](docs/getting-started.md)** — local dev setup and first run
- **[Wiki](docs/wiki/)** — guides, tool reference, troubleshooting
- **[ADRs](docs/adr/)** — architectural decision records
- **[Contributing](CONTRIBUTING.md)** · **[Changelog](CHANGELOG.md)** · **[Security](SECURITY.md)** · **[Code of Conduct](CODE_OF_CONDUCT.md)**

## Roadmap

Status of everything planned. `[x]` done · `[~]` in progress · `[ ]` not started.

### Repo restructure & re-emulation (foundational)

- [x] Monorepo restructure (`packages/hayba` → `mcp-tools/hayba-mcp`, `apps/`, workspace globs) — PR #136
- [x] Re-emulate PRs #110/#112/#113/#134 onto the restructured layout (linguistics L9, sidecar discovery, prompt tools, ESLint/Prettier/CI)
- [x] Local gate green (build `@hayba/*` deps → `tsc` + 185 tests in `mcp-tools/hayba-mcp`)
- [x] CI workflow repointed to the new layout; Node bumped to 22

### Incorporation (this initiative)

- [~] Website → top-level `website/` (re-emulated from `feat/website-integration`, not merged)
- [~] `supabase/` (auth, migrations, edge functions) + reconcile `infra/`
- [~] UE plugin → `unreal/HaybaMCPToolkit/` (snapshot; build artifacts gitignored)
- [ ] **Deferred: linguistics workbench as the website `/app` + `/lang/:id`** — to be wired during a dedicated *linguistics → `apps/hayba-explorer` integration* step (not now). Until then `/app` and `/lang/:id` are graceful placeholders, no `@hayba/linguistics` build coupling.
- [ ] Vercel deploy verified end-to-end (env-var injection, rewrites)

### Documentation & professionalism

- [~] `CONTEXT.md` (domain glossary)
- [~] `docs/adr/` seeded (re-emulation doctrine, website location, plugin location, deferred linguistics integration)
- [~] `docs/ARCHITECTURE.md`
- [~] Per-workspace READMEs (`mcp-tools/hayba-mcp`, `gaea-server`, `design-tokens`, `website`, `unreal/HaybaMCPToolkit`)
- [~] `docs/wiki/` scaffold (glossary, setup, MCP tool reference, UE handler map, troubleshooting)
- [~] Hygiene: `CODE_OF_CONDUCT.md`, `.nvmrc`, `.github/CODEOWNERS`, `.github/dependabot.yml`, root `package.json` metadata
- [ ] Expand `docs/getting-started.md` (prerequisites → MCP host registration → UE connect → sidecar)
- [ ] MCP tool catalog reference (auto-generated from Zod schemas)
- [ ] Coherent versioning + release process (changesets?)

### Architecture deepening (surfaced; future grilling)

Deletion-test-positive opportunities from the friction walk (tectonic excluded) — each needs its own grilling pass before implementation:

- [ ] Fragment the 1606-line tool-registration surface (`mcp-tools/hayba-mcp/src/tools/index.ts`) into per-domain self-registration
- [ ] Consolidate config into a deep `@hayba/config` (hayba-mcp ↔ gaea-server share ports/paths/keys)
- [ ] Collapse thin worldbuilding handler wrappers — derive handlers from package schemas (one schema source)
- [ ] Replace the manual schema-registry bottleneck (registration + schema as one operation)
- [ ] Versioned TCP envelope between `gaea-server`/`hayba-mcp` and the UE plugin
- [ ] Make the dashboard-vs-Tauri decision explicit; inject `architecture-handlers` data root instead of `import.meta.url` path math

### Known constraints

- The authoritative gate is **local**: build `@hayba/*` deps, then `tsc` + `npm test` in `mcp-tools/hayba-mcp`. Run it before pushing.
- Tectonic plate-sim work is **out of scope** for this initiative.

The full backlog with priority/effort lives in [open issues](https://github.com/zajalist/hayba/issues).

## Development

```bash
npm install                                   # all workspaces (Node ≥ 22.5 — see .nvmrc)
npm run -w @hayba/linguistics build           # build workspace TS deps the MCP server needs…
npm run -w @hayba/architecture build          # …(also @hayba/planet-physics)
npm --prefix mcp-tools/hayba-mcp test         # the authoritative gate (tsc + vitest)
```

Run the gate locally before pushing.

## License

Hayba's source code is MIT-licensed (see [LICENSE](LICENSE)).
