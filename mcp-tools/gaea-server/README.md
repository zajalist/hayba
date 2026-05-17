# @hayba/gaea-server — UE5 ⇄ Gaea terrain bridge

A standalone TCP server that turns a natural-language prompt into a
[Gaea 2](https://quadspinner.com/) terrain build: it asks an AI provider to
synthesize a Gaea node graph, writes a `.terrain` (SwarmHost JSON) file, and
invokes the Gaea Build Manager to render a heightmap (and optionally a
SatMap/colour texture).

```
caller ──TCP (length-prefixed JSON)──▶ @hayba/gaea-server ──▶ Anthropic API
                                              │
                                              └──▶ Gaea.BuildManager.exe ──▶ heightmap.png [+ satmap.png]
```

## What it exposes

A single TCP command, `generate_terrain`, validated by a Zod schema
([`src/types.ts`](src/types.ts)):

- **Request:** `{ id, command: "generate_terrain", prompt, outputFolder?,
  resolution? (256–8192, default 1024), includeTexture? }`
- **Response:** `{ id, ok, heightmapPath?, satmapPath?, error? }`

The wire format is the same family as the main Hayba seam — a 4-byte
little-endian length header followed by a UTF-8 JSON body
([`src/index.ts`](src/index.ts)). The build flow lives in
[`src/gaea-builder.ts`](src/gaea-builder.ts): generate graph
([`src/ai-client.ts`](src/ai-client.ts)) → write `.terrain` → run the Build
Manager (5-minute timeout) → return output paths.

## Configuration

All via environment variables ([`src/config.ts`](src/config.ts)):

| Var | Default | Purpose |
|---|---|---|
| `HAYBA_PORT` | `55558` | TCP listen port |
| `AI_API_KEY` | _(empty)_ | Anthropic API key — **required**; generation fails without it |
| `AI_MODEL` | `claude-opus-4-6-20251101` | Model used to synthesize the Gaea graph |
| `GAEA_BUILD_MANAGER` | `C:\Program Files\QuadSpinner\Gaea 2\Gaea.BuildManager.exe` | Gaea Build Manager executable |
| `HAYBA_OUTPUT` | `%TEMP%\hayba-gaea-output` | Default output folder (overridable per request) |

> Provider is fixed to `anthropic`. Do not commit `AI_API_KEY`; supply it via
> the environment.

## Run it

Requires **Node ≥ 20**.

```bash
npm install                          # from the repo root (workspaces)
npm run build -w @hayba/gaea-server  # tsc
AI_API_KEY=... node mcp-tools/gaea-server/dist/index.js
# or, for iteration:
npm run dev -w @hayba/gaea-server    # tsx src/index.ts
```

Scripts: `build` (`tsc`), `dev` (`tsx src/index.ts`), `start`
(`node dist/index.js`), `test` (`vitest run`). The package also exposes a
`hayba-gaea-server` bin.

## Relationship to `@hayba/mcp`

This is a **separate, optional process** on its own port (default `55558`),
not part of the main `@hayba/mcp` stdio surface. The MCP server's
`hayba-bake-terrain` tool is currently a removed stub
(`mcp-tools/hayba-mcp/src/tools/hayba-bake-terrain.ts`), and `@hayba/mcp`'s
in-process Gaea knowledge/layout pipeline lives at
`mcp-tools/hayba-mcp/src/gaea/`. A caller (the UE plugin, or a re-enabled
terrain tool) connects to this server over TCP, sends a `generate_terrain`
envelope, and consumes the returned heightmap path. See
[`../../CONTEXT.md`](../../CONTEXT.md) and the core server
[`../hayba-mcp/README.md`](../hayba-mcp/README.md).
