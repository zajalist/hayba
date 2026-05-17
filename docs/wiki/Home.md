# Hayba Wiki

Orientation hub for the Hayba monorepo. These pages are **pointers and
expansions** — the authoritative sources are the in-repo docs they link to.
Read [`../../CONTEXT.md`](../../CONTEXT.md) first for the domain language.

## Pages

| Page | What |
|---|---|
| [Getting-Started](Getting-Started.md) | Prerequisites + pointer to `docs/getting-started.md` |
| [Architecture](Architecture.md) | The protocol seam, pointer to the architecture docs |
| [MCP-Tool-Reference](MCP-Tool-Reference.md) | How the tool surface is derived; the 34 handler domains |
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
- [`mcp-tools/gaea-server`](../../mcp-tools/gaea-server/README.md) — UE ⇄ Gaea
  bridge
- [`mcp-tools/pcgex`](../../mcp-tools/pcgex/README.md) — PCGEx debug tooling
  (parked)
- [`packages/design-tokens`](../../packages/design-tokens/README.md) — shared
  design tokens
- [`website`](../../website/README.md) — public static site
- [`unreal/HaybaMCPToolkit`](../../unreal/HaybaMCPToolkit/README.md) — the UE5
  plugin
