# Tool Routing (γ Hybrid)

See `docs/superpowers/specs/2026-05-20-mcp-tool-routing-design.md`.

- `settings-watcher.ts` — reads `Saved/HaybaMCP/settings.json`.
- `pack-registry.ts` — domain + workflow packs, load/unload, listChanged.
- `tool-index.ts` — BM25 + embedding hybrid index.
- `meta-tools/` — the 6 always-on tools.
- `packs.yaml` — curated workflow packs.
