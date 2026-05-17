# Getting started

## Prerequisites

- **Node.js ≥ 22.5** (see [`.nvmrc`](../.nvmrc); the codebase uses
  `node:sqlite`)
- **Unreal Engine 5.7+** and **Visual Studio 2022** (to build the plugin)
- Python 3.10+ and [`uv`](https://docs.astral.sh/uv/) (only for the
  optional visual sidecar, Tier 2)

## Step 0 — Clone & install

```bash
git clone https://github.com/zajalist/hayba.git
cd hayba
npm install
```

## Step 1 — Build & verify the MCP server

Verify locally before pushing:

```bash
npm run -w @hayba/linguistics build      # workspace deps the server imports…
npm run -w @hayba/architecture build     # …(also @hayba/planet-physics)
npm --prefix mcp-tools/hayba-mcp test     # tsc --noEmit + vitest (the gate)
npm --prefix mcp-tools/hayba-mcp run build
```

## Step 2 — Install the UE plugin

Copy [`unreal/HaybaMCPToolkit/`](../unreal/HaybaMCPToolkit) into your UE
project's `Plugins/` folder, regenerate Visual Studio project files, and
recompile. See the [plugin README](../unreal/HaybaMCPToolkit/README.md).

## Step 3 — Register the server with your agent host

```bash
# Claude Code
claude mcp add hayba-toolkit -- node /path/to/hayba/mcp-tools/hayba-mcp/dist/index.js
```

Open UE; the **Hayba MCP Toolkit** panel appears in the toolbar. Pick
**Integrated** or **API Key** mode in the onboarding wizard.

## Add-on tiers

### Tier 1 — Core (required)

UE plugin (`unreal/HaybaMCPToolkit`) + Node MCP server
(`mcp-tools/hayba-mcp`). Steps 1–3 above.

### Tier 2 — Visual intelligence (optional, GPU recommended)

```bash
cd mcp-tools/hayba-mcp/addons/visual-embeddings
uv sync --extra gpu          # or --extra cpu
uv run hayba-visual-sidecar  # listens on :7821
```

⚠️ Continuous capture mode causes ongoing GPU load — disable when not
iterating. Configure via Project Settings → Plugins → Hayba MCP Toolkit →
Visual Sidecar.

### Tier 3 — Workflow skills (optional)

Copy `mcp-tools/hayba-mcp/addons/workflows/*` to `~/.claude/skills/`.
Skills: `hayba-new-scene`, `hayba-refine-scene`, `hayba-debug-level`,
`hayba-pcg-build` — SKILL.md guides Claude Code surfaces automatically.

## Troubleshooting

See [`docs/wiki/Troubleshooting.md`](wiki/Troubleshooting.md) — TCP port
conflicts, Node version, workspace-dep build order.
