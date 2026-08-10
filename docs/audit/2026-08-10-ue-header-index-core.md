# UE header documentation index: bounded core (issue #4, slice 1)

Date: 2026-08-10

## What this slice establishes

`mcp-tools/hayba-mcp/src/tools/docs/ue-header-index.ts` is an editor-independent,
database-independent indexing seam for `Engine/Source/**/*.h`:

- deterministic, sorted traversal and machine-independent record IDs/fingerprint;
- canonical public/class include paths plus honest `private`/`fallback` confidence;
- bounded heuristic extraction of classes, structs, enums and functions, including owner,
  normalized signature, short doc comment and stable UE deprecation markers;
- hard limits for files, file/total bytes, symbols, docs, signatures, paths, directory fanout and
  walk depth;
- symlink rejection, canonical-root confinement and bounded file-handle reads with change checks;
- portable artifacts: only Engine/Source-relative paths are serialized, never the installation
  path;
- explicit `truncated`/`skip_counts` metadata instead of presenting a partial corpus as complete;
- deterministic keyword ranking with class/kind filters, supported-API preference, query/result/
  serialized-output budgets, and `semantic_available:false` rather than a false RAG claim.

The parser identifies itself as `bounded_heuristic`. It is deliberately not represented as a C++
compiler and is kept separate from the live reflection-only `docs_*` commands.

## Evidence

```text
npx vitest run src/tools/docs/ue-header-index.test.ts --reporter=verbose
  12 passed

npm run typecheck
  clean
```

Tests pin CRLF-stable identities, include derivation, reflected and macro deprecations, multiline
signatures, function ownership, exclusion of function-body calls and declaration macros,
deterministic traversal, symlink/oversize rejection, no absolute-path leakage, exact-vs-truncated
budgets, rejection of path-like version metadata, deterministic search/filtering,
supported-over-deprecated ranking, and whole-envelope output caps.

Two targeted mutations were also observed red before being reverted: removing the deprecated-API
ranking penalty selects `FDeprecatedActorIterator` over `FActorIterator`; hardcoding
`metadata.truncated=false` hides a file-budget truncation. The final focused suite is green after
both reversions.

## Slice 2: deterministic SQLite publication and recovery

`mcp-tools/hayba-mcp/src/tools/docs/ue-header-database.ts` persists the portable index with Node's
existing built-in `node:sqlite` API. It adds:

- a strict, versioned SQLite schema with application id, index metadata, fingerprint, stable
  ordinals, deprecation fields and deterministic secondary indexes;
- a single-filename output contract under an existing non-symlink root; neither the source root,
  output root nor random staging path is stored;
- mode-restricted private staging, stale-stage cleanup budgets, SQLite `synchronous=FULL`, staging
  quick-check/reopen verification, file sync, atomic rename, and honest directory-sync reporting on
  platforms such as Windows that cannot fsync a directory through Node;
- immutable-publication behavior: cancellation, fingerprint drift, write failure or verification
  failure removes only staging and leaves the prior public database byte-for-byte intact;
- bounded, event-loop-yielding transactions so a real cancellation/shutdown signal is observable
  between chunks instead of one million synchronous inserts blocking the server indefinitely;
- fail-closed handling of destination symlinks and live `-journal`/`-wal`/`-shm` sidecars;
- read budgets, schema/application checks, quick-check, portable runtime row validation, contiguous
  ordinals, metadata/count/fingerprint reconciliation, and corruption classification;
- atomic recovery from a corrupt or old-schema database only after the replacement verifies.

```text
npx vitest run src/tools/docs/ue-header-index.test.ts src/tools/docs/ue-header-database.test.ts
  21 passed (12 index + 9 persistence/recovery)

npm run typecheck
  clean
```

The persistence tests additionally prove deterministic SQLite bytes across identical rebuilds,
post-transaction cancellation rollback, corrupt-file recovery, stale-stage cleanup, read/write
budgets, sidecar preservation, schema migration-by-rebuild, and rejection of hostile row values.
Disabling fingerprint validation was mutation-tested: the forged-index test went red because the
modified records replaced the valid public database. The guard was restored and the suite is green.

## Slice 3: secure MCP query boundary and rebuild CLI

`query_ue_docs` is now a registered low-cost docs tool backed by the versioned SQLite index. Its
boundary adds:

- a strict Zod request schema with bounded query/class strings, an enum symbol-kind filter, a
  1–50 result limit, and only the currently real `keyword` mode;
- canonical catalogue and `list_tool_categories` classification in the `docs` domain, without
  expanding the legacy hard-coded domain list;
- a confined regular-file database location, bounded database/text/symbol loads, coalesced
  concurrent reads, immutable-index caching, and replacement detection;
- stable safe error codes and actionable recovery messages that never expose the configured
  database path, native exception text, or hostile input;
- portable result provenance (engine/indexer/schema versions and fingerprint), signatures,
  declaring types, includes, doc context and explicit deprecation metadata;
- honest `semantic_available:false`, partial-corpus warnings, deprecated-API warnings, no-result
  tips, and an exact 96 KiB UTF-8 byte cap on the pretty-printed MCP response (including multibyte
  source comments).

`scripts/rebuild-ue-docs.mjs` is a user-facing entry point over the same atomic builder. It requires
an explicit Engine/Source root and engine version, accepts bounded file/symbol limits, never prints
or stores installation paths, preserves the prior database on error/cancellation, and exits 130 on
cancellation. Its implementation lives in TypeScript so parsing, redaction and builder wiring are
unit tested rather than duplicated in the launcher.

```text
npx vitest run \
  src/tools/docs/ue-header-index.test.ts \
  src/tools/docs/ue-header-database.test.ts \
  src/tools/docs/query-ue-docs.test.ts \
  src/tools/docs/rebuild-ue-docs-cli.test.ts \
  src/tools/__tests__/register-tools-capture.test.ts
  41 passed

npm run typecheck
  clean

npm run lint:legacy-wrappers
  clean — 22 C++ commands, 153 sidecar entries, no violations

npm run build:server
  clean

node scripts/rebuild-ue-docs.mjs --help
  exit 0; prints only the portable usage and atomic-publication contract
```

The catalogue seam was mutation-tested too: changing `query_ue_docs` from the `docs` route to a
synthetic `query` route made the MCP-boundary test fail with `expected 'query' to be 'docs'`. The
route was restored and the full focused suite above is green.

## What remains before #4 can close

1. Run the builder against the shipping UE 5.7 source corpus, measure extraction precision/recall
   on a reviewed fixture set, and ship that prebuilt DB without Epic source text beyond the bounded
   public snippets permitted by the project/license decision.
2. Add an optional embedding build/search layer. Keyword search is real now; semantic search is not.
3. Validate the prebuilt artifact through the real installed MCP boundary, including reviewed
   relevance queries, rebuild cancellation on the full corpus, and upgrade/corruption recovery.
4. Decide and document the Epic-source licensing/distribution boundary for stored doc snippets and
   any prebuilt index. Until that decision and the real corpus artifact exist, #4 remains open.
