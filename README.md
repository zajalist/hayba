# Hayba

AI-powered terrain and procedural generation. Two MCP servers, one vision.

| Package | What it does | Install |
|---------|-------------|---------|
| **@hayba/gaea** | AI terrain generation via Gaea 2 | `npm i -g @hayba/gaea` |
| **@hayba/pcgex** | AI PCG graph authoring in UE5 | `npm i -g @hayba/pcgex` |

## Quick Start

### HaybaGaea (terrain)
```bash
claude mcp add hayba-gaea -- node packages/gaea/dist/index.js
```

### HaybaPCGEx (procedural geometry)
```bash
claude mcp add -e UE_TCP_PORT=52342 -e UE_TCP_HOST=127.0.0.1 hayba-pcgex -- node packages/pcgex/dist/index.js
```

## Development

```bash
npm install        # Install all workspaces
npm run build      # Build all packages
npm test           # Test all packages
```

## Packages

- [`packages/gaea`](packages/gaea) — HaybaGaea MCP server (11 tools, Gaea 2.x)
- [`packages/pcgex`](packages/pcgex) — HaybaPCGEx MCP server + UE5 C++ plugin (8 tools, UE 5.7)

## Website

[`website/`](website) — Unified Hayba landing page (vanilla HTML/CSS/JS)

## License

MIT
