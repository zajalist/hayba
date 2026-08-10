<div align="center">

# Hayba

**The agentic engine for spatial and procedural world-building in Unreal Engine 5.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![UE 5.7](https://img.shields.io/badge/Unreal_Engine-5.7-blue.svg)](https://www.unrealengine.com/)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-✓-7A8AB8.svg)](https://modelcontextprotocol.io)
[![Tools](https://img.shields.io/badge/Tools-100+_across_30+_domains-green.svg)](#features)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.5-339933.svg)](.nvmrc)

</div>

---

Hayba lets your AI agent (Claude / GPT / any MCP host) author UE5 scenes directly: spawn actors, build PCG graphs, validate physics, author materials, run sandboxed Python, and more — over a single MCP connection. **Spatial-first**: where every other MCP server treats UE as a 2D code repository, Hayba ships a PCG SQLite registry, a native 2D Slate cognitive map, and a visual grounding sidecar.

This repo is the UE5 MCP toolkit: the Node MCP server, the UE5 C++ editor plugin, the Python visual sidecar, and the public website.

## Features

- **100+ tools across 30+ domains** — Actor / Level / Scene / Asset / Blueprint / Material / Foliage / Spline / World Partition / ISM / Physics / Python / Editor / Docs / PCG / Sequencer / Animation / Audio / Behavior Tree / Input / UI / Net / Mesh / Texture / Data / Project / Build / Test / Memory / Plan / Conventions, plus GAS and MetaSound as optional [satellite plugins](docs/adr/0008-satellite-plugins-earn-their-place.md)
- **PCG SQLite registry** — 344 PCGEx nodes / 356 pins / 2270 properties scraped from C++ headers, queryable with semantic + structural intent
- **Cognitive Map** — 2D top-down semantic clustering of every actor in the level, force-directed mindmap renderer
- **Visual sidecar** — FastAPI + CLIP / SpatialCLIP / OWL-ViT for deep physics validation and spatial grounding, plus SAM segmentation for AI mask generation
- **PLUMB constraint system** — a closed primitive set + Semantic Studio for authoring physical-asset profiles, masks, and quantified placement constraints, evaluated as a directional Verdict pre-commit
- **Plan Mode + native transactions** — every destructive AI op wrapped in `GEditor->BeginTransaction` so Ctrl+Z just works
- **Code Mode meta-tools** — 3 tools (`list_tool_categories` / `get_tool_signature` / `python_run`) reduce initial payload by 92%, full catalog discovered on demand
- **Multi-instance safe** — dynamic port allocation (52342-52350) + heartbeat registry so multiple UE instances coexist

## Repository layout

| Path | What it is |
|---|---|
| [`mcp-tools/hayba-mcp`](mcp-tools/hayba-mcp) | **Core product** — the Node/TypeScript MCP server (tool surface, schema registry, TCP client to UE) |
| [`mcp-tools/hayba-mcp/addons/visual-embeddings`](mcp-tools/hayba-mcp/addons/visual-embeddings) | Python FastAPI visual sidecar (CLIP / SpatialCLIP / OWL-ViT + SAM segmentation) |
| `mcp-tools/pcgex` | PCGEx node-registry tooling (see its README) |
| [`unreal/HaybaMCPToolkit`](unreal/HaybaMCPToolkit) | The UE5 C++ editor plugin — command-handler domains, Slate panels, the TCP server half of the protocol |
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
                             │  Zod · PCGEx DB  │        │  handlers      │
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

## Development

```bash
npm install                                   # all workspaces (Node ≥ 22.5 — see .nvmrc)
npm --prefix mcp-tools/hayba-mcp test         # the authoritative gate (tsc + vitest)
```

Run the gate locally before pushing.

## License

Hayba's source code is MIT-licensed (see [LICENSE](LICENSE)).
