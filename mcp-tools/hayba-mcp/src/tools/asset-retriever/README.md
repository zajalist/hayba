# Asset Retriever (Layer 3a)

See `docs/superpowers/specs/2026-05-20-asset-retriever-design.md`.

- `types.ts` — `AssetDoc`, `AssetSource`.
- `asset-indexer.ts` — UE TCP fetch + fallback to list_pcg_assets.
- `asset-index.ts` — hybrid BM25 + embedding store; delta merge; persisted vectors.
- `asset-catalog.ts` — paginated filtered enumeration.
- `asset-verifier.ts` — single-path registry lookup.
- `meta-tools/` — hayba_asset_{search,browse,reindex}.
