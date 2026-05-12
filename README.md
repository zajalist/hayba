# Hayba MCP Toolkit

AI-powered terrain and procedural generation for Unreal Engine 5. One MCP server, one UE plugin.

## Installation

### 1. UE Plugin

Copy `packages/hayba/Plugins/HaybaMCPToolkit/` into your UE project's `Plugins/` folder:

```
YourProject/
  Plugins/
    HaybaMCPToolkit/   ← copy here
```

Right-click your `.uproject` file → **Generate Visual Studio project files**, then recompile. Enable in **Edit > Plugins > Hayba MCP Toolkit**.

### 2. MCP Server

Add to `~/.claude/claude_desktop_config.json` (create it if it doesn't exist):

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

Restart Claude Desktop. You should see **hayba-mcp** connected in the MCP panel.

### 3. First launch

Open UE, go to **Tools > Hayba MCP Toolkit**, and follow the setup wizard to configure your API key and output paths.

## Quick Start

```bash
claude mcp add hayba-mcp -- npx -y @hayba/mcp
```

## Development

```bash
npm install        # Install all workspaces
npm run build      # Build all packages
npm test           # Test all packages
```

## Packages

- [`packages/hayba`](packages/hayba) — Hayba MCP Toolkit (unified server, 26 tools, UE 5.7 plugin)

## Website

[`website/`](website) — Unified Hayba landing page (vanilla HTML/CSS/JS)

## License

Hayba's source code is MIT-licensed (see `LICENSE`).

### Third-party software notice

Hayba operates as an automation client for [QuadSpinner Gaea](https://quadspinner.com/gaea). Running this project requires you to hold a valid Gaea license. Hayba does **not** redistribute Gaea, any Gaea binaries, or QuadSpinner-authored sample `.terrain` files. The MCP server drives Gaea exclusively through its public TCP automation API, which is permitted under Gaea EULA §1.3.3 (automation for licensed rendering, internal production pipelines, or asset integration).

Because hayba is an interactive end-product whose primary purpose involves terrain generation through Gaea, its operation is governed by a custom license agreement between this project and QuadSpinner per Gaea EULA §1.2. The GNN training pipeline under `gaea-gnn/` similarly operates under a custom-license addendum per EULA §1.3.4.

If you publish Assets created by running hayba (renders, displacement maps, color maps, etc.) through retail channels, the Gaea EULA §1.8.2 requires the attribution **"Assets created with QuadSpinner Gaea."** in your public-facing product description.

QuadSpinner® and Gaea® are trademarks of QuadSpinner. No QuadSpinner trademark or logo is used by this project beyond nominative reference.
