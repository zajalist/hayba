# Hayba Wiki

Orientation hub for the Hayba monorepo. These pages are **pointers and
expansions** — the authoritative sources are the in-repo docs they link to.
Read [`../../CONTEXT.md`](../../CONTEXT.md) first for the domain language.

## Pages

| Page | What |
|---|---|
| [Getting-Started](Getting-Started.md) | Prerequisites + pointer to `docs/getting-started.md` |
| [Architecture](Architecture.md) | The protocol seam, pointer to the architecture docs |
| [MCP-Tool-Reference](MCP-Tool-Reference.md) | How the tool surface is derived; the 33 handler domains + 2 satellite plugins |
| [UE-Plugin](UE-Plugin.md) | The UE5 C++ plugin + handler-domain table |
| [Troubleshooting](Troubleshooting.md) | Ports, Node version, the local gate |
| [Glossary](Glossary.md) | One-line definitions of the core terms |

## Authoritative sources

- [`../../README.md`](../../README.md) — project overview + quick start
- [`../../CONTEXT.md`](../../CONTEXT.md) — domain language, the protocol seam,
  hard constraints
- [`../adr/`](../adr/) — Architectural Decision Records
  ([index](../adr/README.md))
- [`../getting-started.md`](../getting-started.md) — add-on tiers / setup
- [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) — contribution workflow

## Workspace READMEs

- [`mcp-tools/hayba-mcp`](../../mcp-tools/hayba-mcp/README.md) — the core MCP
  server
- [`mcp-tools/hayba-mcp/addons/visual-embeddings`](../../mcp-tools/hayba-mcp/addons/visual-embeddings/README.md) — the
  Python visual sidecar (CLIP / SpatialCLIP / SAM)
- [`mcp-tools/pcgex`](../../mcp-tools/pcgex/README.md) — PCGEx debug tooling
  (parked)
- [`website`](../../website/README.md) — public static site
- [`unreal/HaybaMCPToolkit`](../../unreal/HaybaMCPToolkit/README.md) — the UE5
  plugin
