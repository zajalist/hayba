# Glossary

The authoritative glossary is in [`../../CONTEXT.md`](../../CONTEXT.md)
("Glossary" section). These are one-line reminders — read CONTEXT.md for the
full domain language.

- **MCP** — Model Context Protocol; the agent-host ⇄ tool-server protocol
  Hayba speaks over stdio.
- **PCG / PCGEx** — UE Procedural Content Generation and the PCGExtended
  Toolkit; Hayba ships a SQLite registry of PCGEx nodes/pins/properties
  queried by intent.
- **Plan Mode** — every destructive UE op is wrapped in
  `GEditor->BeginTransaction` so `Ctrl+Z` works; a safety invariant, not a
  feature flag.
- **Code Mode** — the small interface (`list_tool_categories` /
  `get_tool_signature` / `python_run`) that hides the full ~100-tool catalog
  until needed; a deliberately *deep* module.
- **Handler domain** — one UE-side command group (Actor, PCG, Sequencer, …)
  implementing `IHaybaMCPHandler` (`GetCommands()` / `Handle()`).
- **Visual sidecar** — optional, degraded-mode-aware Python FastAPI service
  (CLIP / SpatialCLIP / OWL-ViT) for spatial grounding & physics validation.
- **Conlang workbench** — the interactive linguistics UI; currently a
  website-route placeholder, destined for Hayba Explorer (ADR-0003).
- **The TCP seam** — the length-prefixed JSON envelope `{ cmd, id, params,
  auth? }` on `:52342` (fallback `:52343–52350`) between the Node MCP server
  and the UE plugin; the repo's single most important invariant.
- **Re-emulation doctrine** — when a pre-restructure branch's behaviour must
  land on the restructured layout, reproduce its *effect* as fresh commits;
  never git-merge the old layout back in (ADR-0001).

See also: [Architecture](Architecture.md),
[MCP-Tool-Reference](MCP-Tool-Reference.md),
[`../adr/`](../adr/) (recorded decisions).
