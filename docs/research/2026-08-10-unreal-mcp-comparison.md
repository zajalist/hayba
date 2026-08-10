# Unreal MCP comparative audit — 2026-08-10

This is the first reproducible cycle for #372. It compares source that was
current on 2026-08-10 (America/Toronto) against Hayba commit
[`ffdf8a6f`](https://github.com/zajalist/hayba/commit/ffdf8a6f4fad8ae23b6eb0face8297c8e42a4be5).
No competitor code or prose was copied.

## Outcome first

The strongest external ideas are not more raw Unreal actions. Hayba should
adopt four safety/lifecycle patterns and one standards migration:

1. fail-closed, principal-scoped idempotency for mutations;
2. default-on authentication with scoped path/operation authority;
3. request-scoped cancellation plus connection epochs that invalidate late
   work;
4. bounded, centralized response redaction;
5. the stable MCP `2026-07-28` / TypeScript SDK v2 dual-era surface.

Two product capabilities are worth separate, bounded work: deterministic PIE
record/replay with numerical drift evidence, and non-disruptive auto-framed
actor captures with labels. Safe multi-step composition is valuable only after
#369 establishes honest per-command mutation boundaries.

The most urgent finding came from reproducing a competitor's dependency gate on
Hayba itself: `npm audit --omit=dev --json` reports 15 production findings (12
high), and the direct `adm-zip` advisory is reachable through unbounded external
asset download and `extractAllTo`. That is a concrete memory-exhaustion path and
belongs ahead of feature work.

## Method and reproducibility

The reusable method is in
[`TEMPLATE-unreal-mcp-comparison.md`](TEMPLATE-unreal-mcp-comparison.md).
This cycle used GitHub repository metadata, exact commits, release records,
repository source/docs/tests, Epic's Unreal 5.8 documentation, the MCP
specification, and the official TypeScript SDK repository. Hosted product claims
were excluded when the implementation was not inspectable.

Local commands:

```powershell
git rev-parse HEAD
gh issue list --state open --limit 100 --json number,title,labels,url
npm ls @modelcontextprotocol/sdk @hono/node-server serve-static --all --depth=5
npm audit --omit=dev --json
npm outdated --long --json
rg -n "candidate pattern" mcp-tools unreal docs
```

The audit and package metadata are time-sensitive snapshots from 2026-08-10.

## Maintained comparators

| Project | Inspected evidence | License | Architecture | Strongest relevant pattern | Important limitation |
|---|---|---|---|---|---|
| [ChiR24/Unreal_mcp](https://github.com/ChiR24/Unreal_mcp) | `dev` at [`722a435c`](https://github.com/ChiR24/Unreal_mcp/commit/722a435c8ea21e88be0d8f72d80e6172b312ea59), 2026-08-10; latest published release [v0.5.30](https://github.com/ChiR24/Unreal_mcp/releases/tag/v0.5.30), 2026-06-05 | [MIT](https://github.com/ChiR24/Unreal_mcp/blob/722a435c8ea21e88be0d8f72d80e6172b312ea59/LICENSE) | Native C++ bridge plus TS gateway; WebSocket and optional native Streamable HTTP | plugin-authoritative prequeue gate, scopes/path coverage, hashed idempotency ledger, bounded/redacted receipts | its own evidence page says current live/editor certification is incomplete and 5.8 preview does not compile |
| [IvanMurzak/Unreal-MCP](https://github.com/IvanMurzak/Unreal-MCP) | `main` at [`12138b54`](https://github.com/IvanMurzak/Unreal-MCP/commit/12138b549bcfecf73fab32c21d7c8ec469e98463), 2026-08-03; [v0.13.1](https://github.com/IvanMurzak/Unreal-MCP/releases/tag/v0.13.1), 2026-07-28 | [Apache-2.0](https://github.com/IvanMurzak/Unreal-MCP/blob/12138b549bcfecf73fab32c21d7c8ec469e98463/LICENSE) | C++ editor plugin, authenticated loopback NDJSON, supervised .NET bridge, cloud or local server | one-shot stdin token, lifecycle state machine, crash restart/backoff, cooperative cancellation, immediate failure of pending calls, late-result dropping | much of the architecture depends on a larger sidecar/server/cloud stack that Hayba does not need |
| [db-lyon/ue-mcp](https://github.com/db-lyon/ue-mcp) | `main` at [`849a1945`](https://github.com/db-lyon/ue-mcp/commit/849a194598431082f4fd0f2d99ce8233dd52875b), 2026-08-09; [v1.2.4](https://github.com/db-lyon/ue-mcp/releases/tag/v1.2.4), 2026-08-09 | [MIT](https://github.com/db-lyon/ue-mcp/blob/849a194598431082f4fd0f2d99ce8233dd52875b/LICENSE) | TS MCP server plus C++ bridge; 24 coarse domain tools over hundreds of actions | natural-key conflict semantics, inverse receipts, bounded batch preflight, flow compensation, deterministic PIE record/replay/drift | arbitrary shell steps and automatic git restoration are too broad for Hayba's crash/scope posture |
| [GenOrca/unreal-mcp](https://github.com/GenOrca/unreal-mcp) | `main` at [`f7986db2`](https://github.com/GenOrca/unreal-mcp/commit/f7986db239516aa4299ddc6f54d713253bd82631), 2026-07-07; [v2.2.0](https://github.com/GenOrca/unreal-mcp/releases/tag/v2.2.0), 2026-06-17 | [Apache-2.0](https://github.com/GenOrca/unreal-mcp/blob/f7986db239516aa4299ddc6f54d713253bd82631/LICENSE.txt) | Python domain tools with a small native helper/TCP server | offscreen SceneCapture2D, bounds-based framing, on-image actor labels, image content, in-editor tests | its Python-first extension model is exactly the surface Hayba is currently constraining after native crash incidents |

MIT concepts are directly compatible with Hayba's MIT license. Apache-2.0 is
compatible for separately authored ideas; copying code would require preserving
Apache notices and marking changes. This report proposes concepts only.

### ChiR24: adopt the narrow safety contracts, not the breadth race

The pinned
[`security-and-receipts.md`](https://github.com/ChiR24/Unreal_mcp/blob/722a435c8ea21e88be0d8f72d80e6172b312ea59/docs/security-and-receipts.md)
documents and names several load-bearing rules:

- the plugin re-enforces authorization before editor queuing;
- non-loopback native transport refuses to start without token auth;
- scopes are exact sets, unknown capabilities require Admin, and path scans are
  depth/node bounded and fail closed when truncated;
- idempotency slots hash principal + capability + key, do not cache failures,
  never evict in-flight entries, and reject a key reused with a different
  request fingerprint;
- unsafe save/load operations go through centralized wrappers and direct package
  saves are source-contract failures.

The implementation also has bounded recursive secret redaction. Its
[`receipt-redaction.ts`](https://github.com/ChiR24/Unreal_mcp/blob/722a435c8ea21e88be0d8f72d80e6172b312ea59/src/tools/catalog/capabilities/semantic/receipt-redaction.ts)
handles secret-named keys, bearer text, depth limits, array/text limits, and the
special `__proto__` assignment case. Hayba redacts provider API errors locally,
but has no equivalent single response-boundary guarantee for arbitrary handler
data and warnings.

The same repository is unusually honest about evidence. Its pinned
[`performance-and-evidence.md`](https://github.com/ChiR24/Unreal_mcp/blob/722a435c8ea21e88be0d8f72d80e6172b312ea59/docs/performance-and-evidence.md)
labels unmeasured editor claims `BLOCKED`, separates source contracts from live
certification, and gates high-severity production dependency findings in CI.
Hayba should copy that evidence discipline, not its action count.

### IvanMurzak: adopt the lifecycle invariants, not the process topology

The pinned
[`ARCHITECTURE.md`](https://github.com/IvanMurzak/Unreal-MCP/blob/12138b549bcfecf73fab32c21d7c8ec469e98463/docs/ARCHITECTURE.md)
specifies an explicit plugin-side lifecycle:

`Stopped -> LaunchingSidecar -> WaitingHandshake -> Ready <-> Degraded -> Stopping`.

The security/lifetime pieces generalize to Hayba:

- a 32-byte CSPRNG token is delivered over child stdin, never argv or disk;
- the first frame must authenticate within a deadline;
- pending calls fail immediately when IPC disconnects;
- responses for unknown/already-completed request IDs are dropped;
- reconnect resets the manifest revision epoch;
- cancellation is correlated by request ID and tool bodies receive a cooperative
  cancellation flag;
- restart backoff is capped and a crash loop becomes a surfaced terminal state.

Hayba already clears pending requests and partial decoder state on disconnect.
It does not yet propagate MCP cancellation through the TCP frame, nor bind late
native work to a connection/request epoch. Those are the non-duplicative pieces.
Auto-spawning a .NET bridge, cloud SignalR, device-code auth, and a second managed
server process are not appropriate for Hayba's local stdio architecture.

### db-lyon: adopt measured recovery and replay, constrain composition

The pinned
[`handler-conventions.md`](https://github.com/db-lyon/ue-mcp/blob/849a194598431082f4fd0f2d99ce8233dd52875b/docs/handler-conventions.md)
requires create operations to declare a natural key and `onConflict` behavior,
emit an inverse only when state actually changed, capture before-values before a
modify, preflight an entire bounded batch, and report per-item outcomes once
execution begins. This validates the direction of Hayba #369 rather than opening
a duplicate issue.

The pinned [`flows.md`](https://github.com/db-lyon/ue-mcp/blob/849a194598431082f4fd0f2d99ce8233dd52875b/docs/flows.md)
adds reverse-order inverse calls, failure/finally hooks, plans, and per-step
events. Hayba should eventually compose only registered tools, allow retries
only where idempotency permits, cap steps/nesting/time, and preserve #370's
`unknown_outcome`/partial-mutation semantics. It should not copy arbitrary shell
steps or automatic project-tree reset.

The strongest distinct feature is
[`pie-record-replay.md`](https://github.com/db-lyon/ue-mcp/blob/849a194598431082f4fd0f2d99ce8233dd52875b/docs/pie-record-replay.md):
Enhanced Input capture, frame/state samples, seeded replay, observation profiles,
and numerical drift reports. Hayba has input injection and capture primitives,
but no recording/replay/drift contract. A bounded implementation would turn
“the bug reproduced” from agent prose into evidence.

### GenOrca: adopt actor evidence capture, not unrestricted Python extension

The pinned
[`vision_actions.py`](https://github.com/GenOrca/unreal-mcp/blob/f7986db239516aa4299ddc6f54d713253bd82631/Plugins/UnrealMCPython/Content/Python/UnrealMCPython/vision_actions.py)
creates a transient SceneCapture2D and render target, frames selected actor
bounds, projects actor origins onto the image, labels them, deletes the capture
actor, and returns an MCP image. The paired
[`test_vision.py`](https://github.com/GenOrca/unreal-mcp/blob/f7986db239516aa4299ddc6f54d713253bd82631/Plugins/UnrealMCPython/Content/Python/UnrealMCPython/tests/test_vision.py)
checks PNG identity and cleanup around a disposable actor.

Hayba should implement the outcome in its safe native capture seam: no viewport
movement, strict pixel/byte limits before allocation, bounded actor count and
label length, weak/short-lived object references, cleanup on every path, and a
file-backed image content block rather than base64 inside the 8 MiB UE response.
The Python source itself is not a template: broad Python execution is currently
the subject of #366 because it can register dangling engine callbacks and crash
the editor.

## Official Unreal and MCP baselines

Epic's [Unreal MCP 5.8 documentation](https://dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor)
says the experimental server uses local Streamable HTTP, serializes tool calls
on the game thread, discovers reflected Python/C++ toolsets, supports dynamic
direct registration, defaults to three tool-search meta-tools, and has no auth.
It explicitly warns clients not to overlap calls. Hayba is already stronger in
authentication options, plan gating, deferred routing, domain breadth, and
crash investigation. Replacing the hardened TCP seam with Epic's experimental
in-process HTTP server would add an unauthenticated attack surface and is not an
improvement.

One Epic API detail is worth adopting as a source contract. The official
[`FModelContextProtocolServer` API](https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/ModelContextProtocol/FModelContextProtocolServer)
exposes an `AliveGuard`; asynchronous completions capture a weak pointer that is
invalidated in the destructor to prevent use-after-free. Hayba now uses this
pattern in important TCP/chat seams, but should enforce it for every async
completion/delegate registration rather than rely on review.

MCP [`2026-07-28`](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
is now the current specification. It introduces the stateless modern era,
request metadata, cacheable deterministic list results, and multi-round-trip
`input_required` results. The official TypeScript SDK shipped stable v2 packages
on 2026-07-27, including
[`@modelcontextprotocol/server@2.0.0`](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/%40modelcontextprotocol/server%402.0.0).
Its pinned
[`upgrade-to-v2.md`](https://github.com/modelcontextprotocol/typescript-sdk/blob/cc4b41617ce3601b1290d67216ea0b194a3cd9ac/docs/migration/upgrade-to-v2.md)
and
[`support-2026-07-28.md`](https://github.com/modelcontextprotocol/typescript-sdk/blob/cc4b41617ce3601b1290d67216ea0b194a3cd9ac/docs/migration/support-2026-07-28.md)
describe dual-era stdio, request-scoped cancellation, cache hints, and MRTR.

Hayba's lockfile contains `@modelcontextprotocol/sdk` 1.29.0. Migration should
preserve 2025-era clients while adding the modern era. Issue #11's custom
fire-and-poll input protocol should then be aligned with `input_required`
instead of creating a second public interaction standard. The Tasks extension
should be deferred until the exact v2 API is stable and needed; do not infer a
task implementation merely from the specification.

## Immediate local vulnerability result

`npm audit --omit=dev --json` returned 15 production findings: 0 critical, 12
high, 2 moderate, and 1 low. Reachability differs and must be decided per path.

| Dependency/finding | Local reachability on 2026-08-10 | Decision |
|---|---|---|
| `adm-zip` 0.5.17, [GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85), crafted ZIP can trigger a 4 GB allocation | **direct and reachable**: `asset-sources/shared.ts` downloads without a byte ceiling and calls `extractAllTo` without entry/count/uncompressed-size/ratio/path/symlink preflight | P0 issue; patch dependency and independently enforce archive budgets before extraction |
| `@modelcontextprotocol/sdk` 1.29.0 -> `@hono/node-server`, [GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9) | shipped dependency; Hayba's MCP entry is stdio, so the vulnerable static-file route is not proven reachable | update at least to fixed v1.30 lock immediately; separately migrate to v2; record route reachability rather than claim exploitability |
| `js-yaml` 4.1.1, [GHSA-52cp-r559-cp3m](https://github.com/advisories/GHSA-52cp-r559-cp3m) and [GHSA-5p4m-2wfm-xmqj](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj) | direct; loads workflow pack/config YAML. Inputs are normally repository-owned, but a malicious project/config can cause quadratic CPU work | update to 4.3.1+ and add YAML byte/alias/depth/collection limits where parsing untrusted project files |
| `@huggingface/transformers` -> `onnxruntime-node`, `sharp`, `protobufjs`, `adm-zip` | lazy-loaded embedding backend; advisories are present, but each model/image/protobuf path needs reachability analysis | separate dependency-reachability inventory; disable or sandbox a backend whose vulnerable parser is reachable until patched |

Adopt ChiR24's CI posture in a Hayba-appropriate form: a production-only audit
gate, an explicit allowlist for assessed exceptions with expiry and reachability,
and a scheduled job. A green audit must not be manufactured by hiding a finding
under `audit-level`; high findings block.

## Proposed independently closeable backlog

These are issue-ready. Numbers should be assigned by GitHub; existing issues are
named where the work belongs there.

### P0 — Harden untrusted asset downloads and archive extraction

**Evidence:** reachable `adm-zip` advisory and unbounded local call path above.

**Scope:** stream downloads with a configured compressed-byte limit and deadline;
write to a unique temp file; inspect the central directory before extraction;
reject absolute/traversal/device paths, symlinks/reparse points, duplicate
normalized names, excessive entries, excessive per-entry/total uncompressed
bytes, and extreme compression ratios; extract one validated entry at a time
inside a resolved destination; clean partial output on failure; update the
dependency; add a blocking production audit gate with assessed-expiry records.

**Proof:** synthetic ZIPs for 4 GB declared size, zip slip, backslash traversal,
symlink, duplicate path, entry flood, ratio bomb, truncated archive, network
overrun, and valid small archive. Assert bounded memory/time, no writes outside
the temp root, no partial import, and no editor call after rejection.

### P0 — Principal-scoped idempotency ledger for mutating requests

**Evidence:** ChiR24's ledger contract; Hayba only prevents its own blind retry
for a denylist and cannot deduplicate client retries after an unknown outcome.

**Scope:** accept an explicit idempotency key outside handler params; slot by a
hash of principal + command + key; fingerprint canonical command/params; states
`in_flight` and `completed`; replay only verified completed outcomes; never cache
failures/refusals/unknown outcomes; never evict in-flight entries; bound TTL and
capacity; conflicting fingerprints fail without disclosing the earlier request.

**Proof:** simultaneous duplicates cause one mutation; reconnect replay returns
one receipt; changed params conflict; failure remains retryable; cap pressure
never admits a second in-flight mutation; raw keys never reach logs/journal.

### P0 — Default-on local authentication and scoped authority

**Evidence:** ChiR24's plugin-authoritative scopes/path coverage and IvanMurzak's
one-shot stdin token. Hayba's persistent capability token is optional and empty
by default.

**Scope:** auto-generate a strong token on first use; constant-time comparison;
never log/echo it; make unauthenticated mode an explicit warning-bearing dev
opt-out; define read/write/destructive/admin authority and permitted project/Game
paths; validate in the plugin before queueing; bounded recursive path coverage
fails closed if truncated; unknown commands require admin/refuse.

**Proof:** missing/wrong token, timing contract, token rotation, secrets absent
from logs/crash artifacts, scope matrix, nested/path-alias/traversal corpus,
depth/node truncation, and a live attempt proving refusal leaves dirty/object
state unchanged.

### P0 — Production dependency reachability and audit gate

This can land separately from archive hardening so CI starts preventing new
exposure immediately.

**Scope:** update fixed direct dependencies; produce a machine-readable inventory
of every remaining production advisory, importing feature, reachability decision,
owner, expiry, and mitigation; fail CI on new/unassessed high findings and on
expired exceptions; scheduled audit issue creation.

**Proof:** fixture advisory is rejected; dated assessed exception passes until
expiry; dev-only advisory does not block production lane; current high findings
are either removed or have explicit, reviewed reachability records.

### P1 — MCP TypeScript SDK v2 and 2026-07-28 dual-era migration

**Evidence:** stable v2 release and current spec above; Hayba is locked to 1.29.0.

**Scope:** use the official split v2 packages; continue serving legacy stdio
clients; negotiate/support modern requests; deterministic cached tool lists;
request-scoped abort signal; MRTR `input_required` seam; no public handler rewrite
until transport compatibility is proven. Route generic user input from #11
through this seam, retaining the Unreal panel as a client UI.

**Proof:** official Inspector/SDK clients in both eras list/search/call the same
tools; cancellation stops a cooperative handler and reports unknown mutation
state honestly; modern input-required round-trip and legacy shim both work; tool
catalog bytes/order remain stable; all existing stdio registration tests remain
green.

### P1 — Cancellation and connection-epoch contract across Node/TCP/Unreal

**Evidence:** IvanMurzak lifecycle; Epic `AliveGuard`; Hayba currently drops Node
pending promises but cannot cancel queued/native work.

**Scope:** correlated cancel frame; per-connection epoch/generation; remove a
cancelled request before execute when queued; cooperative token checkpoints for
bounded multi-step handlers; never force-kill game-thread C++; drop late results
whose epoch/request is closed; teardown invalidates every async completion;
classify cancel-after-execute as `unknown_outcome` unless verification proves it.

**Proof:** cancel queued, cancel mid-loop, disconnect during execute, editor
restart with reused Node process, late response, module shutdown with callback,
and cancellation storm. Survival harness must prove no crash, no reply on a new
connection, bounded queues, and accurate dirty/mutation advisory.

### P1 — Central bounded secret redaction at the response boundary

**Evidence:** ChiR24 redaction contract; Hayba has only provider-specific error
redaction.

**Scope:** recursively redact secret-looking keys and assignments in data,
errors, warnings, tips, journal detail, and tool-stream mirrors; preserve harmless
measurements such as `token_count`; explicit depth/node/array/text/output limits;
safe handling of `__proto__`, `constructor`, and `prototype`; no mutation of the
handler-owned object; surface truncation as a machine fact.

**Proof:** mixed case/camel/snake/concatenated secret keys, bearer text, nested
arrays/maps, 100+ depth, cycles at TS boundary, prototype keys, huge warnings,
and false-positive vocabulary. Raw sentinel secrets must be absent from every
serialized response, log, journal, panel mirror, and crash test artifact.

### P1 — Safe registered-tool flows with compensation receipts

**Dependency:** complete #369 first; do not mask per-command partial mutation with
an orchestration layer.

**Scope:** plan and run only registered Hayba tools; strict step/nesting/runtime
and output caps; data references to prior bounded results; before/finally hooks;
idempotency-aware retry only; reverse-order compensation records; distinguish
editor undo, explicit compensation, durable saves, skipped/unreverted effects,
and unknown outcomes. No arbitrary shell task and no automatic git reset.

**Proof:** preflight rejection causes zero mutations; failure after two steps
compensates in reverse; non-reversible save reports durable partial state;
cancel/disconnect/SEH stops scheduling new steps; retry never duplicates a
mutation; one live disposable flow leaves zero dirty/probe artifacts.

### P1 — Deterministic PIE record/replay and drift evidence

**Evidence:** db-lyon's record/replay/observe contract; no Hayba implementation
match.

**Scope:** bounded Enhanced Input recording, pawn transform/velocity and selected
safe reflected values; explicit recording handle; seeded replay through the real
input path; status/stop/delete; offline and live drift summaries; output only
under `Saved/HaybaMCP/Recordings`; per-session state machine with EndPIE,
PreExit, map-change, and module-shutdown cleanup.

**Crash constraints:** cap duration, sample rate, actions, actors, properties,
frames, image count, and total bytes; weak references only; delegate handles
unregistered on every terminal path; background encoding owns copied pixels,
never UObjects; no transaction retaining PIE objects.

**Proof:** deterministic fixture, threshold pass/fail, stop/re-arm, missing pawn,
map change, PIE end, module shutdown, corrupt recording, oversized request,
multi-client refusal/cap, and repeated 100-session soak with zero delegates,
UObjects, dirty packages, or residual files after cleanup.

### P2 — Auto-framed, labelled actor evidence capture

**Route:** complements #15/#28/#34; update those issues rather than creating
three competing capture implementations.

**Scope:** offscreen transient capture that does not move the user's viewport;
frame bounded actor geometry; overlay stable short labels/IDs; return found and
missing actors plus exact camera pose; file-backed MCP image; optional no-label
mode. Reuse the single capture seam and worker PNG encoder.

**Proof:** invalid/stale/hidden/huge-bounds actors, zero-size bounds, actors behind
camera, dimension and byte caps, output-file failure, editor shutdown during
encode, repeated capture cleanup, unchanged viewport, no dirty packages, and
image dimensions/PNG signature. Never place base64 PNG inside the UE TCP JSON.

## Existing issue routing

- **#369:** incorporate natural-key conflict semantics, full batch preflight,
  per-item outcomes after the mutation boundary, and explicit inverse/compensation
  facts. Do not open a duplicate per-handler atomicity issue.
- **#370/#371:** centralized advisories remain the response-state authority;
  redaction happens after classification/verbosity filtering and cannot be
  disabled. Secret truncation/redaction facts are machine-readable, not tips.
- **#11:** retain the editor Plan/Input UI, but align the transport contract with
  MCP `input_required` after the v2 migration instead of exposing only custom
  fire-and-poll tools.
- **#15:** replace “base64 thumbnail in catalog response” with file-backed image
  content, strict counts/bytes, and no eager image blobs in search results.
- **#28:** continuous capture must sample only while subscribed, use a bounded
  ring/latest frame, expose age/drops, and auto-stop on overload/PIE/world exit.
- **#34:** RHI readback is an optimization after the same lifetime/byte-limit
  contract is proven; it is not a second public capture surface.
- **#5:** copy ChiR24's measured/blocked evidence discipline: units, source,
  sample window, caps, and “not measured” fields are part of every perf response.

## Explicit exclusions for this cycle

- **No action-count race.** ChiR24 and db-lyon expose very broad surfaces, but
  breadth without live evidence conflicts with Hayba's honest-capability rule.
- **No unrestricted Python extension model.** GenOrca demonstrates velocity,
  not safety; #366 exists because one-shot Python can retain dead engine
  callbacks and crash later.
- **No arbitrary shell steps in flows.** That expands authority beyond the
  plugin's scopes, path gate, idempotency, advisory, and crash boundary.
- **No automatic git snapshot restore.** A broad checkout/reset can destroy
  unrelated user work and cannot safely reload every affected UObject. Explicit
  per-step compensation and durable-state receipts come first.
- **No direct Epic HTTP replacement yet.** Epic documents loopback/no-auth,
  experimental formats, and serial game-thread calls. Hayba's hardened TCP plus
  stdio MCP boundary remains the smaller trusted surface.
- **No sidecar/cloud topology transplant.** IvanMurzak's supervised process
  rules are useful; its .NET/SignalR/cloud stack is not necessary.
- **No Resources/Prompts expansion based on competitor presence alone.** Epic
  ships none, IvanMurzak wires them empty, and Hayba already has one catalog
  resource. A concrete read-only workload must prove value first.
- **No hosted Flop/Aura implementation claims.** The
  [Flopperam repository at `b1b495b7`](https://github.com/flopperam/unreal-engine-mcp/commit/b1b495b7c396002108ecf5fed7853e5799be834c)
  says its hosted product is a separate codebase, and the inspected repository
  has no license file. Marketing can identify a use case, not an auditable design
  or reusable implementation.
- **Historical only:** [chongdashu/unreal-mcp at `4e5f00da`](https://github.com/chongdashu/unreal-mcp/commit/4e5f00da50733190481311e254d16d137a84ef33)
  and [kvick-games/UnrealMCP at `f989d0e7`](https://github.com/kvick-games/UnrealMCP/commit/f989d0e77a4bae68c0dfc92bbcaf24ceefd06efb)
  last pushed implementation changes in 2025. They remain useful provenance for
  basic architecture, not current safety leadership.

## Revisit triggers

- any Hayba or dependency security advisory;
- Epic 5.8 final/5.9 MCP lifecycle changes;
- MCP TypeScript SDK v2 minor with Tasks or cancellation changes;
- new releases from the four maintained comparators;
- completion of #365–#371, which changes the Hayba side of the matrix;
- next scheduled cycle: 2026-09-10.
