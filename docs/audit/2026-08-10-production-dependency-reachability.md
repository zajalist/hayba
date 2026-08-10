# Production dependency reachability — 2026-08-10

The machine authority is
[`production-dependency-assessments.json`](production-dependency-assessments.json).
Issue #397 removes the final time-bounded exceptions rather than extending
them for a different top-level version.

## Observed before and after

The baseline was `origin/main` at
`2a0533c121802ae84ce2fdfc039eb3db951247d0`. On that lockfile,
`npm audit --omit=dev --json` reported four high production vulnerability
nodes and no other production vulnerabilities:

| Package | Resolved version | Advisory path |
| --- | --- | --- |
| `@huggingface/transformers` | 4.0.1 | both advisories below, via its production graph |
| `sharp` | 0.34.5 | `GHSA-f88m-g3jw-g9cj` |
| `onnxruntime-node` | 1.24.3 | `GHSA-xcpc-8h2w-3j85`, via `adm-zip` |
| `adm-zip` | 0.5.17 | `GHSA-xcpc-8h2w-3j85` |

GitHub's reviewed Sharp advisory marks releases below 0.35.0 affected and
0.35.0 patched. The reviewed AdmZip advisory marks releases below 0.6.0
affected and 0.6.0 patched. These are the primary advisory records:

- [Sharp / libvips advisory](https://github.com/advisories/GHSA-f88m-g3jw-g9cj)
- [AdmZip allocation advisory](https://github.com/advisories/GHSA-xcpc-8h2w-3j85)

The local Transformers backend was optional and already had two complete
fallbacks: a locally managed Ollama service for semantic embeddings and the
always-available MiniSearch/BM25 index. Removing the backend was therefore a
smaller and safer boundary than forcing incompatible transitive versions into
Transformers' exact ONNX dependency graph.

After removing the direct dependency and regenerating the lockfile,
`npm audit --omit=dev --json` reports zero critical, high, moderate, or low
production vulnerabilities. The four package keys above are absent from both
the MCP manifest and the root lock package map. The assessment inventory is now
empty because retaining stale exceptions is a policy error.

## Install and runtime boundary

Root Node CI installs use `npm ci --ignore-scripts`; the nested dashboard build
does the same. npm documents that `--ignore-scripts` prevents package lifecycle
scripts during a clean install:
[npm ci / ignore-scripts](https://docs.npmjs.com/cli/v11/commands/npm-ci/#ignore-scripts).

More importantly, default production installs no longer contain Transformers,
Sharp, ONNX Runtime, or AdmZip at all. That removes the ONNX native installer
and its archive path rather than merely suppressing their lifecycle scripts.
Hayba does not download embedding models. At runtime it only probes the user's
existing local Ollama endpoint with a two-second abort signal; refusal,
timeout, or offline failure returns `null`, and the server builds its lexical
index from a cold cache.

The clean-install CI lane runs a focused fallback contract before the full MCP
suite. It proves that an offline probe is bounded, a fresh cache is populated
without vector files, warm and cold lexical rankings are identical, and the
non-embedding index remains usable. The production graph contract also rejects
the return of any of the four removed package keys.

## Executable policy

Run from the repository root:

```powershell
npm run audit:production
```

The script launches `npm audit --omit=dev --json`, parses raw JSON in memory,
and emits only sanitized policy codes and counts. CI and the weekly scheduled
audit both install from the lockfile with lifecycle scripts disabled before
running the same gate.
