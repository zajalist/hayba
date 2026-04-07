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

MIT
