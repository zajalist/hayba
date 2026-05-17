# mcp-tools/gaea — locator

**Status: not a standalone workspace.** There is no separate `mcp-tools/gaea`
package; this file exists only to point at where Gaea integration actually
lives, because the root README lists "`mcp-tools/gaea`" alongside
`mcp-tools/pcgex` as "supporting MCP tooling".

Gaea functionality is split across two real locations:

| Where | What |
|---|---|
| [`../gaea-server`](../gaea-server) | The standalone TCP bridge between UE5 and Gaea terrain generation (prompt → Gaea graph → heightmap). Has its own README. |
| `../hayba-mcp/src/gaea/` | The in-process Gaea knowledge / layout-engine / terrain-pipeline modules used by `@hayba/mcp` (knowledge stores, scraped Gaea docs + transcripts, `query-gaea-knowledge` tool). |

There is nothing to build or run here. See
[`../gaea-server/README.md`](../gaea-server/README.md) for the runnable
bridge and [`../hayba-mcp/README.md`](../hayba-mcp/README.md) for the core
server. Architectural orientation: [`../../CONTEXT.md`](../../CONTEXT.md).
