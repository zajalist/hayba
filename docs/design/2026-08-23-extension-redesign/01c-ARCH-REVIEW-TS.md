# Architecture review — TS MCP server (agent report, 2026-08-23)

> Produced by a read-only review agent over `mcp-tools/hayba-mcp/src`
> (81,077 lines incl. tests and sidecar.json). Top claims spot-verified by the
> main session (dashboard bypass at `dashboard/api.ts:34,86,114`; `index.ts`
> = 3,873 lines; the material-add-node double schema — all confirmed).
> Vocabulary: module / interface / seam / adapter / depth.

## 1. Module map (condensed)

| Module | Depth verdict | Key leak |
|---|---|---|
| `tcp-client.ts` | Deep for the wire | leaks raw `TcpResponse` upward; module singleton needs `_resetClientForTesting` |
| `tools/tool-executor.ts` | **Deepest module in the repo** — cost→timeout tiering, heavy-op tier, idempotency-gated retry, UE error mapping, editor-busy diagnosis behind one function | `NON_IDEMPOTENT` is an exported **mutable Set** (127 hard-coded names) other modules write into |
| `tools/` (index.ts) | interface small, file is not — 3,873 lines, 186 inline descriptors, ~300 imports | every tool's zod shape visible at top level |
| `plumb/` | shallow-by-interface: 8 store modules exporting load/get/put/remove/setPath quintets — persistence not hidden | `tools/plumb/tools.ts` (585 L) re-implements orchestration on top |
| `slivers/` | **Deep and clean** — one setup fn; `runSliver` never rejects | minor |
| `dag/` | Deep — journal replay, edge inference, hashing hidden | handlers read `journal`/`dag` directly |
| `validator/` | mixed; mutable rule table patched at runtime | three parallel finding systems |
| `chat/` | agent-loop deep; `chat-server.ts` (835 L) does 5 jobs | 4 test-only exports poke module globals |
| `agents/llm-client.ts` | Deep (2 providers, 1 interface) | 24 exports from one 1,000-line file |
| `tools/routing/register.ts` | interface = one fn; implementation = 586 lines doing 8 jobs | `RoutingHandle` leaks five subsystems |

## 2. Seam inventory

- **`Sender` (`tool-executor.ts:224`) — the healthiest seam**: 2 real adapters
  (live TCP + `InMemoryToolExecutor`), used by dozens of tests.
- **`executeCommand`** — the universal UE chokepoint; 65 non-test files.
- **`toMcpResponse`** — a mostly-bypassed seam: **9** uses vs **180**
  hand-rolled `content:[{type:'text'…}]` envelopes across 40+ files. Two files
  in the same directory give opposite adoption advice (`tool-result.ts:11-13`
  says don't adopt broadly; `ue-tool.ts:10-13` complains about exactly that).
- **`ueTool`** — 71 call sites, genuine; but hard-codes its own error string,
  forking the error contract.
- **`UeProbe` (`validator/ue-probe.ts:24`)** — model narrow seam; copy it.
- **`SliverUeBridge`** — clean throw→structured conversion at the boundary.

**Bypasses:** (1) `dashboard/api.ts:34,86,114` — raw `getUEClient().send()`
×3, skipping timeout tiers, retry gate, `UeToolError`; invisible to the
WORKFLOW Step-4 grep because that grep only scans `src/tools/`. (2)
`register.ts:504-517` replaces `hayba_check_ue_status`'s captured handler —
same tool name, two implementations by mode. (3) `dispatchLegacy` skip is
documented and intentional.

## 3. Duplication — counted

**8 distinct paths for a tool to reach UE:** ueTool (71) / hand-written
executeCommand / pyTemplate factory (10 domain files) / legacy-tool-factory
(~55) / hayba_invoke / hayba_invoke via ue_legacy / chat dispatcher (a
near-verbatim copy of invoke's algorithm, self-acknowledged at
`tool-dispatch.ts:20`, differing only in envelope unwrapping) / raw dashboard
sends.

**5 competing response constructors:** okResult/errorResult (44/45 uses),
toMcpResponse (9), inline envelopes (**180**), ueTool's inline error (71 via
factory), RichToolResult (1).

**Schemas declared twice:** 111 wrappers export `schema`; index.ts imports 66;
**90 descriptors re-declare the shape inline** with hand-copied `.describe()`
strings (verified: `material-add-node.ts:13-26` ≡ `index.ts:1983-1994`).
`schema-single-source.test.ts` spot-checks ~10 tools only.

**Non-idempotency declared twice:** 127 names centrally + 10 per-domain
`*_NON_IDEMPOTENT` arrays; a drift test exists (right mitigation, confirms
the duplication is structural).

**5 finding/verdict shapes** (ValidatorFinding, UiFinding, ContentFinding,
BaseFinding, PLUMB Verdict/InstanceVerdict) — `tools/plumb/tools.ts:30-36`
imports two of them and hand-converts. (= ADR-0009's target, now with exact
inventory.)

**Timeout policy in two places** with alias-pair entries
(`landscape_import`/`import_landscape` …) — the tool-name/wire-name namespace
confusion reappearing as data.

## 4. Dependency direction

- 12 upward imports (non-tools → tools) in 5 files. The bad one:
  `chat/agent-loop.ts:42-45` reaches into four tool registries to re-derive
  what `get_tool_signature` already computes.
- `tools/index.ts` imports ~300 modules — nothing loads without everything.
- `tools/pcg/pcg-scatter-mesh.ts:20` imports a sliver executor's internals
  rather than running the sliver.
- Oversized files where size is NOT justified: `index.ts` (3,873 — ≥6 jobs),
  `llm-client.ts` (1,000 — 4 jobs), `chat-server.ts` (835 — 5 jobs),
  `register.ts` (586 — 8 jobs). The ~1,000-line `*-py-tools.ts` files are
  data tables and are fine.

## 5. Testability

Good through-the-interface: slivers, dag, tcp-frame-decoder, tool-executor
(via InMemoryToolExecutor), ue-probe, tool-index, idempotency-ledger,
llm-client.

Past-the-interface: **50 of ~150 test files call `readFileSync`, mostly to
read source code.** The 23 `*-contract.test.ts` files pin **implementations in
another language** — asserting on C++ lambda capture lists,
`MakeUnique<...>` occurrence counts, and comment banners. They encode
expensive lessons and must not be deleted — but they are drift *lints*, not
tests, and belong in `scripts/contracts/` as a separate gate. Several other
"tests" (`no-stub-wrappers`, `production-dependency-reachability`,
`io-boundary-drift`, `wire-command-names`) are the same category.

## 6. The add-a-tool gate today

**N = 4 files minimum, 7 typical, 9 worst case**: wrapper file → import in
index.ts → descriptor in index.ts (with schema re-declared) → sidecar.json;
plus conditionally NON_IDEMPOTENT, HEAVY_OPS (+ alias spellings), packs.yaml,
inferDir prefix, param-aliases/CORE_META. The worst single part: step 3
re-states the schema the wrapper already declares.

Three overlapping gating mechanisms with different coverage:
`settings.toolRouting==='deferred'`, `config.codeMode`, and
`isToolDisabled()` — the last is checked on the pack path but **not** on the
passthrough path (`register.ts:487`) or the check-ue-status path (`:504`).

## Ranked improvements (agent's top 10, endorsed)

1. **Collapse the schema double-declaration** — wrapper exports one
   `ToolDescriptor` via `defineTool`; index.ts becomes per-domain barrel
   concatenation. ~90 files, mechanical; diff `get_tool_signature` output
   before/after.
2. **Split `tools/index.ts`** into per-domain `descriptors.ts` barrels +
   `catalogue.ts` + a lean `register.ts`; `inferDir` dies when barrels declare
   their pack.
3. **One envelope module** (`ok`/`err`/`rich`); delete `tool-result.ts`'s
   "do not adopt" note; lint (in scripts/) forbidding inline
   `content:[{type:'text'` outside it. 180 sites, byte-identical substitution.
4. **One `ToolDispatcher`** behind both `hayba_invoke` and chat
   (`createDispatcher({captured, execute, unwrap})`); pin the plan-mode-pause
   unwrap difference with a test first.
5. **Decompose `registerDeferredRouting`** into pure builders + one
   `registerName()` helper so the `isToolDisabled` check cannot be skipped.
6. **Close the dashboard bypass** (3 raw sends → `executeCommand`) and widen
   the Step-4 lint to all of `src/` with an explicit allowlist.
7. **Derive `retry:'safe'|'never'` and `blocksGameThread` from descriptor
   meta**, killing the 127-name mutable Set and the 10 domain arrays —
   AFTER resolving the wire-name/tool-name namespace (see 10).
8. **One `Finding` type** across validator/ui/content/plumb (= ADR-0009 W2),
   with a read-side migration for the on-disk history.
9. **Reclassify the 23 contract tests as `scripts/contracts/` drift lints**;
   replace substring assertions with sidecar.json-derived structure where
   possible. Relocation, not removal.
10. **Branded `WireCommand` type** — `wireCommand(name)` sole constructor,
    validated against sidecar keys; the compiler replaces the grep. Type-only,
    65 files.

## Load-bearing — do not break

The Sender seam + InMemoryToolExecutor; executeCommand as sole chokepoint;
UeProbe as the model seam; SliverUeBridge's boundary conversion;
`captureStaticToolCatalogue`/`materializeTool` (registration as a value);
cross-cutting policy applied once at the registration seam
(`withValidationNudge`/`withEvidenceWarning`/`appendNicheBriefing`);
**`response-evidence.ts` — "a response is a claim, not evidence" is the single
most valuable invariant in the codebase**; the 8-tool deferred default surface
(and the comment documenting the 49-tool regression it fixed); slivers/ and
dag/ as the two cleanest deep modules; the frame decoder extraction; and
`docs/WORKFLOW-improving-the-mcp.md` itself — every dangerous pattern above is
already described there; the gaps are scope, not understanding.
