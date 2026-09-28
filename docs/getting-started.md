# Getting started

## Prerequisites

- **Node.js ≥ 22.5** (see [`.nvmrc`](../.nvmrc); the codebase uses
  `node:sqlite`)
- **Unreal Engine 5.7+** (UE 5.7 or 5.8) on Windows, and **Visual Studio with the C++ toolchain your Unreal Engine version requires** (to build the plugin)
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
npm install                               # all workspaces (Node ≥ 22.5)
npm --prefix mcp-tools/hayba-mcp test     # tsc --noEmit + vitest (the gate)
npm --prefix mcp-tools/hayba-mcp run build
```

## Step 2 — Install the UE plugin

Link [`unreal/HaybaMCPToolkit/`](../unreal/HaybaMCPToolkit) into your UE
project's `Plugins/` folder from an administrator prompt (or with Windows
Developer Mode on), then regenerate Visual Studio project files and
recompile:

```bat
mklink /D "<YourProject>\Plugins\HaybaMCPToolkit" "<repo>\unreal\HaybaMCPToolkit"
```

The link lets the plugin find the MCP server built in Step 1. If you copy the plugin instead, set `SidecarEntryPath` under `[HaybaMCPToolkit]` in `<YourProject>/Saved/Config/WindowsEditor/EditorPerProjectUserSettings.ini` to the full path of `mcp-tools/hayba-mcp/dist/index.js`.
See the [plugin README](../unreal/HaybaMCPToolkit/README.md).

## Step 3 — Register the server with your agent host

```bash
# Claude Code
claude mcp add hayba-toolkit -- node /path/to/hayba/mcp-tools/hayba-mcp/dist/index.js
```

On first launch the **Hayba MCP Toolkit** tab opens by itself (later: **Window > Tools > Hayba MCP Toolkit**, or the console command `Hayba.MCP.Open`). Your MCP host drives the agent. To chat inside the editor instead, set a provider (and key, for cloud models) under **Settings > AI / LLM Backend**. Plan Mode is on by default: approve plans in the Plan tab.

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

See [Getting started — Visual Sidecar](getting-started-visual-sidecar.md)
for install details, environment variables, and how the "Model Preset" /
per-capability toggles relate to what you actually installed.

### Tier 3 — Workflow skills (optional)

Copy `mcp-tools/hayba-mcp/addons/workflows/*` to `~/.claude/skills/`.
Skills: `hayba-new-scene`, `hayba-refine-scene`, `hayba-debug-level`,
`hayba-pcg-build` — SKILL.md guides Claude Code surfaces automatically.

See [Getting started — Skills bundle](getting-started-skills-bundle.md) for
what each skill's workflow actually does.

### Swarm agents and shared memory

Two more add-on pieces referenced by `hayba.agents.json` and the onboarding
wizard, with an honest look at what's wired up today versus what's still a
config template:

- [Getting started — Swarm agents](getting-started-swarm-agents.md)
- [Getting started — Memory system](getting-started-memory-system.md)

## Troubleshooting

See [`docs/wiki/Troubleshooting.md`](wiki/Troubleshooting.md) — TCP port
conflicts, Node version, workspace-dep build order.
