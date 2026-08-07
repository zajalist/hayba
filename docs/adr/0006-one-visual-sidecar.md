# 0006 — One visual sidecar, one interface

**Status:** Accepted (2026-08-07)

## Context

There were two FastAPI applications. Both titled `hayba-visual-sidecar`. Both
defaulting to port **7821**. Serving disjoint endpoints:

| | |
|---|---|
| `mcp-tools/visual-sidecar` | `/health` `/segment_project` |
| `mcp-tools/hayba-mcp/addons/visual-embeddings` | `/health` `/embed` `/validate` |

One **adapter** sits on that seam — `src/tools/visual/sidecar-client.ts` — and it
issues `/health`, `/embed` and `/segment_project` against a single base URL. So
whichever process was running, half the adapter was broken.

It was worse than half. The client derives `available` from `/health`'s `models`
map. The segmentation app returned `{ok, model_loaded}` with no `models` key, so
starting it made the client report the sidecar **unavailable** and
`assertSidecarAvailable()` then refused calls to a process that was running and
healthy.

Nothing caught this because the contract existed only as hand-mirrored
TypeScript interfaces — there was no interface at the seam, only two
implementations that had each guessed at one.

`docs/ARCHITECTURE.md` had always described a single sidecar
"(CLIP / SpatialCLIP / SAM)", and `docs/getting-started.md` told users to run
`uv run hayba-visual-sidecar` — the packaged app's console script — while
pointing at the other app's directory. The docs described the intended design.
The split was the accident.

## Decision

**One sidecar**, at `mcp-tools/hayba-mcp/addons/visual-embeddings`. It owns the
console script the docs already reference, and it is the path dependabot and CI
already point at. Segmentation, projection, the UE-side study renderer and the
tests moved into it; `mcp-tools/visual-sidecar/` is gone.

Two rules follow, and they are the reason this is an ADR rather than a commit:

1. **`/health` declares every capability the process can serve.** The client
   reads that map to decide availability, so a capability missing from it is a
   capability the client will refuse to use.
2. **Capability is not warm-up state.** `models.sam` reports whether
   segmentation *could* run (import resolves, checkpoint on disk);
   `model_loaded` reports whether it has been warmed. `"clip": true` used to be
   hardcoded, which meant `/health` claimed CLIP on a process that could not
   import it.

A corollary, enforced by CI: **model dependencies import inside the function
that needs them, never at module scope.** `/health` exists to answer when the
models are absent, and while `clip_model.py`, `owl_vit.py` and `spatial_clip.py`
imported torch at module scope it was the first thing to break when they were.
The sidecar job installs torch-free on purpose — installing it would hide a
regression in this property rather than test it.

## Consequences

- `tests/test_client_contract.py` asserts every endpoint the adapter calls is
  actually served, and that `/health` carries a non-empty `models` map. The next
  drift fails a test instead of silently degrading.
- Adding an endpoint means adding it *here*. A second sidecar process is how the
  7821 collision happened.
- `/embed` currently has no MCP tool in front of it: its only callers were three
  unregistered files, deleted 2026-08-07. The endpoint and its client function
  are real and tested, but unreachable from an agent. That is a product gap, not
  dead code to prune — recorded so it is not rediscovered as a surprise.
- `scipy` and `imageio[freeimage]` are hard runtime requirements of
  back-projection, not test extras. Both were present by accident on a
  development machine and absent on a clean runner.
