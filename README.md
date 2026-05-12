<div align="center">

# Hayba MCP Toolkit

**The ultimate agentic engine for spatial and procedural world-building in Unreal Engine 5.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![UE 5.7](https://img.shields.io/badge/Unreal_Engine-5.7-blue.svg)](https://www.unrealengine.com/)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-✓-7A8AB8.svg)](https://modelcontextprotocol.io)
[![Tools](https://img.shields.io/badge/Tools-100+_across_34_domains-green.svg)](docs/superpowers/specs/2026-05-06-hayba-ue-expansion-design.md)

</div>

---

Hayba lets your AI agent (Claude / GPT / any MCP host) author UE5 scenes directly: spawn actors, build PCG graphs, validate physics, generate terrain, run sandboxed Python, and more — over a single MCP connection. **Spatial-first**: where every other MCP server treats UE as a 2D code repository, Hayba ships a PCG SQLite registry, a native 2D Slate cognitive map, and a SpatialCLIP visual grounding sidecar.

## Features

- **100+ tools across 34 domains** — Actor / Level / Scene / Asset / Blueprint / Material / Foliage / Spline / World Partition / ISM / Physics / Python / Editor / Docs / PCG / Sequencer / Animation / Niagara / Audio / MetaSound / GAS / Behavior Tree / Input / UI / Net / Mesh / Texture / Data / Project / Build / Test / Memory / Plan / Conventions
- **PCG SQLite registry** — 344 PCGEx nodes / 356 pins / 2270 properties scraped from C++ headers, queryable with semantic + structural intent
- **Cognitive Map** — 2D top-down semantic clustering of every actor in the level, force-directed mindmap renderer (Obsidian-style)
- **Visual sidecar** — FastAPI + CLIP / SpatialCLIP / OWL-ViT for deep physics validation and spatial grounding
- **Plan Mode + native transactions** — every destructive AI op wrapped in `GEditor->BeginTransaction` so Ctrl+Z just works
- **Source-control integrated Diff panel** — Git / Perforce / SVN aware; check-out / submit AI mutations through your existing pipeline
- **In-editor tool stream** — live trace of every MCP call, grouped by Claude turn, with per-turn selection / archive / copy
- **Code Mode meta-tools** — 3 tools (`list_tool_categories` / `get_tool_signature` / `python_run`) reduce initial payload by 92%, full catalog discovered on demand
- **Multi-instance safe** — dynamic port allocation (52342-52350) + heartbeat registry so multiple UE instances coexist
- **Two modes**: Integrated (Claude Desktop / Code / Cursor over stdio) or API Key (direct Anthropic / OpenAI from in-editor chat panel)

## Quick start

### 1. Install the UE plugin

Drop `packages/hayba/Plugins/HaybaMCPToolkit/` into your project's `Plugins/` folder, regenerate Visual Studio files, recompile.

### 2. Register the MCP server with your agent host

```bash
# Claude Code
claude mcp add hayba-toolkit -- node /path/to/Plugins/HaybaMCPToolkit/ThirdParty/mcp_server/dist/index.js
```

```jsonc
// Claude Desktop — claude_desktop_config.json
{
  "mcpServers": {
    "hayba-toolkit": {
      "command": "node",
      "args": ["/path/to/Plugins/HaybaMCPToolkit/ThirdParty/mcp_server/dist/index.js"]
    }
  }
}
```

### 3. Run the editor

Open UE, the **Hayba MCP Toolkit** panel appears in the toolbar. Walk through the onboarding wizard to pick **Integrated** (your existing MCP host drives the agent) or **API Key** (in-editor chat panel drives Anthropic / OpenAI directly).

That's it. Ask Claude: *"Search the PCG node catalog for voronoi, propose a 3-step plan to author a Voronoi graph, and execute it after I approve."*

## Architecture

```
┌──────────────────┐       ┌──────────────────┐      ┌────────────────┐
│  Agent Host      │ stdio │  Node MCP Server │ TCP  │  UE5 Plugin    │
│  (Claude / GPT)  │ ◄──►  │  (TypeScript)    │ ◄──► │  (C++)         │
└──────────────────┘       │                  │      │                │
                           │  Zod schemas     │      │  34 handlers   │
                           │  PCGEx SQLite    │      │  Slate panels  │
                           │  Disabled gates  │      │  Visual sidecar│
                           └──────────────────┘      └────────────────┘
```

Two language boundaries, one protocol. The TCP envelope on `:52342` (auto-fallback to `:52343-52350`) carries length-prefixed JSON. Plan Mode and the editor transaction system gate every destructive op.

## Documentation

- **[Full design spec](docs/superpowers/specs/2026-05-06-hayba-ue-expansion-design.md)** — 34-domain command catalog, sidecar architecture, swarm agents, spatial intelligence system
- **[Market positioning & gap analysis](docs/superpowers/specs/2026-05-06-hayba-ue-expansion-design.md#9-market-positioning--gap-analysis-2026-update)** — competitor matrix, defensibility ranking, 10 prioritized engineering initiatives
- **[Contributing](CONTRIBUTING.md)** — dev setup, commit conventions, PR checklist
- **[Changelog](CHANGELOG.md)** — release notes

## Roadmap

Every initiative from the [market-research roadmap](docs/superpowers/specs/2026-05-06-hayba-ue-expansion-design.md#9-market-positioning--gap-analysis-2026-update) is tracked as a GitHub issue. Highlights in flight:

- 🚧 PIE test harness assertions
- 🚧 UE documentation RAG (SQLite of UE 5.7 C++ API)
- 🚧 Performance telemetry endpoints (memory profiler, draw call audit)
- 🚧 Blueprint compilation safety gates
- 🚧 Headless CLI runner for CI/CD pipelines

See [open issues](https://github.com/zajalist/hayba/issues) for the full backlog with priority + effort estimates.

## Packages

| Path | Description |
|---|---|
| [`packages/hayba`](packages/hayba) | Hayba MCP Toolkit — Node TypeScript server + UE5 C++ plugin |
| [`packages/hayba/addons/visual-embeddings`](packages/hayba/addons/visual-embeddings) | FastAPI sidecar (CLIP / SpatialCLIP / OWL-ViT) for visual grounding |
| [`website/`](website) | Landing page (vanilla HTML/CSS/JS) |

## Development

```bash
npm install        # All workspaces
npm run build      # Build all packages
npm test           # Test all packages
```

The pre-commit hook (`.githooks/pre-commit`) typechecks `packages/hayba` and restages `dist/` whenever you commit a TS change — keeps the installed plugin's bundled MCP server fresh.

## License

Hayba's source code is MIT-licensed (see [LICENSE](LICENSE)).

### Third-party software notice

Hayba operates as an automation client for [QuadSpinner Gaea](https://quadspinner.com/gaea). Running the Gaea pipeline requires a valid Gaea license. Hayba does **not** redistribute Gaea, any Gaea binaries, or QuadSpinner-authored sample `.terrain` files. The MCP server drives Gaea exclusively through its public TCP automation API, permitted under Gaea EULA §1.3.3.

QuadSpinner® and Gaea® are trademarks of QuadSpinner. No QuadSpinner trademark or logo is used by this project beyond nominative reference.
