<div align="center">

# Hayba

**The agentic engine for spatial and procedural world-building in Unreal Engine 5.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![UE 5.7+](https://img.shields.io/badge/Unreal_Engine-5.7+-blue.svg)](https://www.unrealengine.com/)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-✓-7A8AB8.svg)](https://modelcontextprotocol.io)
[![Tools](https://img.shields.io/badge/Tools-400+_across_30+_domains-green.svg)](#features)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.5-339933.svg)](.nvmrc)

</div>

---

Hayba lets your AI agent (Claude / GPT / any MCP host) author UE5 scenes directly: spawn actors, build PCG graphs, validate physics, author materials, run sandboxed Python, and more — over a single MCP connection. **Spatial-first**: Hayba ships a PCG SQLite registry, a native 2D Slate cognitive map, and a visual grounding sidecar.

This repo is the UE5 MCP toolkit: the Node MCP server, the UE5 C++ editor plugin, the Python visual sidecar, and the public website.

## Features

- **400+ editor tools across 30+ domains** — Actor / Level / Scene / Asset / Blueprint / Material / Foliage / Spline / World Partition / ISM / Physics / Python / Editor / Docs / PCG / Sequencer / Animation / Audio / Behavior Tree / Input / UI / Net / Mesh / Texture / Data / Project / Build / Test / Memory / Plan / Conventions, plus GAS and MetaSound as optional [satellite plugins](docs/adr/0008-satellite-plugins-earn-their-place.md)
- **PCG SQLite registry** — 344 PCGEx nodes / 356 pins / 2270 properties scraped from C++ headers, queryable with semantic + structural intent
- **Cognitive Map** — 2D top-down semantic clustering of every actor in the level, force-directed mindmap renderer
- **Visual sidecar** — FastAPI + CLIP / SpatialCLIP / OWL-ViT for deep physics validation and spatial grounding, plus SAM segmentation for AI mask generation
- **PLUMB constraint system** — a closed primitive set + Semantic Studio for authoring physical-asset profiles, masks, and quantified placement constraints, evaluated as a directional Verdict pre-commit
- **Plan Mode + native transactions** — with Plan Mode on (the default), destructive steps wait until you approve the plan. Most editor edits land on Unreal's normal undo stack, so Ctrl+Z works — not during Play-In-Editor, and not for asset deletes, saves to disk or arbitrary Python.
- **Deferred tool discovery** — the server starts with 7 tools; the agent searches the full catalogue and calls the rest on demand, which keeps the initial tool list small
- **Multi-instance safe** — dynamic port allocation (52342-52350) + heartbeat registry so multiple UE instances coexist

## Repository layout

| Path | What it is |
|---|---|
| [`mcp-tools/hayba-mcp`](mcp-tools/hayba-mcp) | **Core product** — the Node/TypeScript MCP server (tool surface, schema registry, TCP client to UE) |
| [`mcp-tools/hayba-mcp/addons/visual-embeddings`](mcp-tools/hayba-mcp/addons/visual-embeddings) | Python FastAPI visual sidecar (CLIP / SpatialCLIP / OWL-ViT + SAM segmentation) |
| `mcp-tools/pcgex` | PCGEx node-registry tooling (see its README) |
| [`unreal/HaybaMCPToolkit`](unreal/HaybaMCPToolkit) | The UE5 C++ editor plugin — command-handler domains, Slate panels, the TCP server half of the protocol |
| [`website/`](website) | Public website (static HTML/CSS/JS) — see [`docs/website-README.md`](docs/website-README.md) |
| `infra/`, `supabase/` | Self-host infra (docker-compose, Caddy, Cloudflare tunnel) + Supabase backend (auth, migrations, edge functions) |

## Quick start

### 1. Build the MCP server

```bash
git clone https://github.com/zajalist/hayba.git
cd hayba
npm install                                  # all workspaces (Node ≥ 22.5)
npm --prefix mcp-tools/hayba-mcp run build
```

### 2. Install the UE plugin

Create `<YourProject>\Plugins` first if it doesn't exist, then link [`unreal/HaybaMCPToolkit/`](unreal/HaybaMCPToolkit) into it from an administrator prompt (or with Windows Developer Mode on):

```bat
mklink /D "<YourProject>\Plugins\HaybaMCPToolkit" "<repo>\unreal\HaybaMCPToolkit"
```

Then regenerate Visual Studio project files and recompile (Windows; UE 5.7 or 5.8; Visual Studio with the C++ toolchain your Unreal Engine version requires). The link lets the plugin find the MCP server you just built. If you copy the plugin instead, set `SidecarEntryPath` under `[HaybaMCPToolkit]` in `<YourProject>/Saved/Config/WindowsEditor/EditorPerProjectUserSettings.ini` to the full path of `mcp-tools/hayba-mcp/dist/index.js`.

### 3. Register the MCP server with your agent host

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

### 4. Run the editor

On first launch the **Hayba MCP Toolkit** tab opens by itself (later: **Tools > Hayba MCP Toolkit**, or the console command `Hayba.MCP.Open`). Your MCP host drives the agent. To chat inside the editor instead, set a provider (and key, for cloud models) under **Settings > AI / LLM Backend**. Plan Mode is on by default: approve plans in the Plan tab.

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

Two language boundaries, one protocol. The TCP envelope on `:52342` (auto-fallback `:52343-52350`) carries length-prefixed JSON. With Plan Mode on (the default), destructive steps wait until you approve the plan, and most editor edits run inside editor transactions, so Ctrl+Z works — not during Play-In-Editor, and not for asset deletes, saves to disk or arbitrary Python. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`CONTEXT.md`](CONTEXT.md).

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
