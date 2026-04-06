# Hayba — Development Guidelines

## Repo Structure
- `packages/hayba/` — Hayba MCP Toolkit (unified MCP server + UE5 C++ plugin)
- `website/` — Unified landing page (vanilla HTML/CSS/JS)
- `assets/` — Shared brand assets (Logo.svg)

## TypeScript
- ES modules (`"type": "module"`)
- 2-space indent, no semicolons optional but consistent per file
- Strict mode on — no `any`, no `!` assertions without comment
- kebab-case filenames, PascalCase classes, camelCase functions/vars
- snake_case MCP tool names with `hayba_` prefix (e.g. `hayba_bake_terrain`)

## Commits
Follow Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`

## MCP Tools
- Tool names: snake_case with `hayba_` prefix
- All inputs validated with zod
- Return `{ content: [{ type: 'text', text: JSON.stringify(...) }] }`

## Build
```bash
npm install       # root — installs all workspaces
npm run build     # builds packages/hayba via tsc
npm test          # runs vitest in packages/hayba
```

## UE5 Plugin (packages/hayba/Plugins/HaybaMCPToolkit)
- UE 5.7 API — use `UPCGPin` not deprecated pin helpers
- TCP port: 52342 (commands), 52341 (dashboard)
- JSON framing: 4-byte LE length prefix + UTF-8 JSON body
- Deployed to: `D:/UnrealEngine/geoforge/Plugins/HaybaMCPToolkit/`
