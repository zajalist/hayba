# Architecture

How the pieces fit. Read [`CONTEXT.md`](../CONTEXT.md) first for the
domain language; decisions are in [`docs/adr/`](adr/).

## One protocol, two language boundaries

```
┌──────────────┐  stdio   ┌───────────────────────┐  TCP :52342  ┌─────────────────────┐
│  Agent host  │ ───────▶ │  Node MCP server      │ ───────────▶ │  UE5 C++ plugin      │
│ Claude / GPT │ ◀─────── │  mcp-tools/hayba-mcp  │ ◀─────────── │  unreal/HaybaMCP...  │
└──────────────┘  MCP     └───────────────────────┘  len-prefix  └─────────────────────┘
                            Zod schemas · PCGEx DB     JSON         33 handler domains
                            Code Mode · disabled gates               Slate panels
```

- **stdio boundary** — MCP (Model Context Protocol). The agent host speaks
  MCP to the Node server. The server's *interface* is the set of tools +
  their Zod schemas.
- **TCP boundary (the seam)** — a length-prefixed JSON envelope
  `{ cmd, id, params, auth? }` on `:52342` (fallback `:52343-52350`). Two
  **adapters**: `mcp-tools/hayba-mcp/src/tcp-client.ts` (Node) and
  `FHaybaMCPTcpServer` (UE C++). They must agree on the envelope — the
  repo's central invariant.

## Data flow: a tool call

1. Agent calls an MCP tool (e.g. `actor_spawn`) on the Node server.
2. Server validates `params` against the tool's Zod schema.
3. Server's TCP client frames `{cmd,id,params}` and sends it to the UE
   plugin on the discovered port.
4. UE routes `cmd` to the owning **handler domain** (`IHaybaMCPHandler`).
   Destructive ops are wrapped in `GEditor->BeginTransaction` (**Plan
   Mode**) so `Ctrl+Z` works.
5. UE replies with a length-prefixed JSON result; the server returns it
   to the agent.

**Code Mode** keeps the interface small: `list_tool_categories` /
`get_tool_signature` / `python_run` expose the ~100-tool catalog on
demand instead of in the initial payload.

## Multi-instance

Each UE editor publishes its port to `Saved/HaybaMCP/instances/<pid>.json`;
the Node client discovers the live instance. Ports auto-allocate in
`52342–52350` so multiple editors coexist.

## Language map

| Layer | Language | Where |
|---|---|---|
| Tool surface, schemas, TCP client | TypeScript (Node ≥22.5) | `mcp-tools/hayba-mcp` |
| Visual grounding sidecar | Python (FastAPI) | `mcp-tools/hayba-mcp/addons/visual-embeddings` |
| Terrain bridge | TypeScript | `mcp-tools/gaea-server` |
| Editor plugin, handlers, panels | C++ (UE 5.7) | `unreal/HaybaMCPToolkit` |
| Desktop explorer | Rust + React (Tauri) | `apps/hayba-explorer` |
| Worldbuilding libs | TypeScript | `apps/hayba-explorer/packages/*`, `packages/architecture` |
| Website | static HTML/CSS/JS | `website/` |
| Backend / self-host | SQL + Docker | `supabase/`, `infra/` |

## Build & verify

The authoritative gate is local — run it before pushing:

```bash
npm install
npm run -w @hayba/linguistics build     # + @hayba/architecture, @hayba/planet-physics
npm --prefix mcp-tools/hayba-mcp test    # tsc --noEmit + vitest
```

`mcp-tools/hayba-mcp` imports `@hayba/{linguistics,architecture,planet-physics}`
whose `package.json` `main`/`exports` point at built `dist/`, so those
deps must be built before the server typechecks/tests.

## Surfaced deepening opportunities

Friction points flagged for future grilling (see README roadmap): the
1606-line tool-registration surface, config duplication
(hayba-mcp ↔ gaea-server), thin worldbuilding wrappers, the manual
schema-registry bottleneck, the un-versioned TCP envelope, the
dashboard-vs-Tauri ambiguity.
