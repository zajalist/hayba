# Architecture

The authoritative long-form doc is [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
(language boundaries, the TCP seam, satellite plugins, the typed domain
seam). [`../../CONTEXT.md`](../../CONTEXT.md) ("The protocol seam" section)
is the shorter domain-language version, and decisions are recorded in
[`../adr/`](../adr/). This page is a summary/pointer, not a third copy —
read the two files above for anything not covered here.

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
  **big-endian** length header precedes the UTF-8 JSON body
  (`buffer.readUInt32BE` in `src/tcp-frame-decoder.ts`). Responses are
  `{ id, ok, data?, error? }`, correlated by `id`.
- **Two adapters on the seam** that must agree on the envelope:
  `mcp-tools/hayba-mcp/src/tcp-client.ts` (Node, `UETcpClient`) and the UE
  plugin's `FHaybaMCPTcpServer`. This agreement is the single most important
  invariant in the repo.
- **UE plugin** (`unreal/HaybaMCPToolkit`) — the C++ editor adapter: 33
  command-handler domains + Slate panels, plus two optional satellite
  plugins (`HaybaMCPGAS`, `HaybaMCPMetaSound` — see
  [ADR-0008](../adr/0008-satellite-plugins-earn-their-place.md)). The plugin
  publishes its actual port to `Saved/HaybaMCP/instances/<pid>.json` for
  multi-editor setups.

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
