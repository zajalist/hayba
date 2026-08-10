# `lru-cache` production reachability (2026-08-10)

Issue: #401

## Decision

Remove the direct `lru-cache` dependency from `@hayba/mcp`. The package had no
production source consumer, so updating it would maintain install and audit
surface without providing capability.

## Evidence before removal

- `git grep` found no `lru-cache` literal under
  `mcp-tools/hayba-mcp/src/`.
- `npm explain lru-cache --workspace @hayba/mcp` reported one edge only:
  `@hayba/mcp@1.0.0 -> lru-cache@11.5.0` from the direct manifest range.
- `npm ls lru-cache --omit=dev --all` reported the same single direct edge and
  no transitive production parent.
- The root lock contained one `node_modules/lru-cache` entry, version 11.5.0.

The nested dashboard lock still contains transitive `lru-cache@5.1.1`. It is a
different dependency graph owned by the dashboard build and is not the removed
MCP runtime declaration.

## Regression contract

`production-dependency-reachability.test.ts` performs a comment-aware scan of
non-test production source. It recognizes value imports, re-exports,
import-equals, dynamic `import()`, `require()` and `require.resolve()`. It
requires the direct manifest declaration and reachable runtime consumers to
agree, so either an unused declaration or an undeclared new consumer fails the
test. The guard is self-contained because TypeScript 7 exposes its compiler API
only through explicitly unstable entry points.
