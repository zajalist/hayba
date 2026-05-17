# Architecture

The authoritative architectural orientation is
[`../../CONTEXT.md`](../../CONTEXT.md) ("The protocol seam" section) and the
recorded decisions in [`../adr/`](../adr/). The root
[`../../README.md`](../../README.md) and the UE plugin README reference a
long-form `docs/ARCHITECTURE.md`; that file is a **planned expansion** of the
CONTEXT.md seam section and does not exist yet — use CONTEXT.md until it
lands.

## The protocol seam (summary)

One protocol across two language boundaries:

```
Agent host ──stdio──▶ Node MCP server ──TCP──▶ UE5 C++ plugin
 (Claude/GPT)        (mcp-tools/hayba-mcp)    (unreal/HaybaMCPToolkit)
```

- **MCP server** (`mcp-tools/hayba-mcp`) — the Node/TypeScript module. Its
  interface is the set of MCP tools + their Zod schemas. Entrypoint:
  `src/index.ts` (stdio transport + local dashboard + visual-sidecar probe).
- **TCP seam** — a **length-prefixed JSON envelope** `{ cmd, id, params,
  auth? }` on `:52342` (auto-fallback `:52343–52350`). A 4-byte
  little-endian length header precedes the UTF-8 JSON body. Responses are
  `{ id, ok, data?, error? }`, correlated by `id`.
- **Two adapters on the seam** that must agree on the envelope:
  `mcp-tools/hayba-mcp/src/tcp-client.ts` (Node, `UETcpClient`) and the UE
  plugin's `FHaybaMCPTcpServer`. This agreement is the single most important
  invariant in the repo.
- **UE plugin** (`unreal/HaybaMCPToolkit`) — the C++ editor adapter: 34
  command-handler domains + Slate panels. The plugin publishes its actual
  port to `Saved/HaybaMCP/instances/<pid>.json` for multi-editor setups.

## Key properties

- **Code Mode** — the server exposes only 3 meta-tools by default and
  discovers the full ~100-tool catalog on demand (a deliberately *deep*
  module). See [MCP-Tool-Reference](MCP-Tool-Reference.md).
- **Plan Mode** — every destructive UE op is wrapped in
  `GEditor->BeginTransaction` so `Ctrl+Z` works (a safety invariant).
- **Visual sidecar** — optional, degraded-mode-aware Python FastAPI service
  for spatial grounding / physics validation.

See also: [UE-Plugin](UE-Plugin.md), [Glossary](Glossary.md),
[`../../mcp-tools/hayba-mcp/README.md`](../../mcp-tools/hayba-mcp/README.md).
