# Hayba editor-crash threat model — 2026-08-10

This report turns the local crash history into an executable inventory. Its source of truth is
[`crash-threat-model.json`](crash-threat-model.json); a contract test rejects duplicate IDs or
signatures, missing guard/recovery/test ownership, unsourced resolved claims, arithmetic drift,
and accidental host-private data.

## Evidence boundary

The inspected window is **2026-07-20 03:01:17.209 UTC through 2026-08-10 03:38:37.898 UTC**. It contains
264 crash-report directories and 97 distinct non-empty engine `PCallStackHash` values. The counts
below are deliberately two different measurements:

- **Artifacts** count crash-report directories. Unreal writes these for ensures as well as fatal
  process exits, so this is not an editor-death count.
- **Signatures** count distinct engine-provided stack hashes. This is the deduplication unit. A
  root cause may still acquire a new hash when its call site or binary changes.

No report path, project asset name, source excerpt, request payload, machine/account identifier,
or crash GUID is retained. Existing repository audit and handoff documents supply reproduction
evidence for incidents whose crash reporter metadata does not contain a recognizable signature.

## Corpus classification

Classification is conservative and precedence-based: UMG GUID → PIE teardown/reference →
transaction-buffer retention → automation execution → D3D12/RHI → constructor helper → security
post-fault re-entry → dynamic delegates → Slate runtime collections → abstract assets → async
imports → PIE type mismatch. First match wins, which keeps the rows disjoint.

| Stable class                                                   | Artifacts | Signatures | Current disposition                                         |
| -------------------------------------------------------------- | --------: | ---------: | ----------------------------------------------------------- |
| `HCR-UMG-001` stale UMG variable GUID map                      |       153 |         57 | Resolved; direct compile regression                         |
| `HCR-PIE-001` PIE world/object survives teardown               |         6 |          4 | Mitigated; survival regression still needed                 |
| `HCR-TRANS-001` transaction buffer retains PIE object          |        68 |          3 | Mitigated; static policy exists, survival regression needed |
| `HCR-AUTO-001` unsafe automation lifecycle/test object         |        17 |         16 | Resolved for the MCP runner; host tests remain their owners |
| `HCR-RHI-001` RHI/render teardown fault                        |         2 |          2 | Open                                                        |
| `HCR-CTOR-001` constructor helper used at runtime              |         2 |          1 | External host-project defect                                |
| `HCR-SEH-001` handler fault followed by unsafe post-processing |         2 |          2 | Resolved; fault tail has an early-return contract           |
| `HCR-DELEG-001` reflected dynamic delegate cannot bind         |         4 |          3 | External host-code defect                                   |
| `HCR-SLATE-001` Slate collection/item lifetime corruption      |         6 |          5 | External host runtime-UI defect                             |
| `HCR-DATA-001` abstract data-asset class reaches AssetTools    |         1 |          1 | Open; handler preflight is missing                          |
| `HCR-IMPORT-001` async Fab/Interchange source-node failure     |         2 |          2 | External engine/third-party pipeline                        |
| `HCR-PIETYPE-001` PIE duplication returns wrong object class   |         1 |          1 | External host asset/class defect                            |
| **Unclassified**                                               |     **0** |      **0** | **Clear for this evidence window**                          |

The classified rows reconcile exactly to 264 artifacts and 97 signatures. The release threshold
is zero unclassified signatures, so the current manifest says `audit_threshold.met: true`.
That is a statement about this bounded corpus, not universal coverage: the classifier emits an
opaque one-way fingerprint for any future unknown and immediately makes the threshold fail.

The original pass left 14 signatures unclassified. Mining their sibling editor logs and module
families reduced them without guessing: three were one reflected-delegate defect; five were Slate
list/item identity or lifetime faults; one was the second half of PIE initialization; one passed
an abstract class to AssetTools; two belonged to the Fab/Interchange import pipeline; one was a
PIE object-class mismatch; and one was the post-fault crash already described by `HCR-SEH-001`.
That last signature has an unsymbolicated final stack, so its rule is intentionally narrow: it
requires the same local incident log to show the constructor-helper fatal during `level_load`, the
SEH guard returning control, a later successful ping, and then the Core/Engine/UnrealEd access
violation. No single one of those markers is enough.

## Reproduce the counts

Run the classifier against a local Unreal crash directory; it emits no paths, messages, call
stacks, crash GUIDs, asset names, or identity fields:

```text
node mcp-tools/hayba-mcp/scripts/audit-crash-threat-model.mjs \
  --crash-dir <Saved/Crashes> \
  --check-manifest docs/audit/crash-threat-model.json
```

Exit code 0 means the evidence window, first-match order, per-class artifact/signature totals,
missing-signature count, and opaque unknown fingerprints all match the committed manifest.
The classifier reads sibling logs only to attribute an otherwise unsymbolicated post-SEH crash;
their contents never enter its output.

## Reproduced and adversarial classes outside the classifier

The manifest also owns reproduced or source-audited classes that cannot honestly inherit a corpus
count: world switching during the MCP tick, Python callbacks/threads escaping a request, malformed
or oversized TCP frames, partitioned foliage lookup without a level hint, self-deadlocking
game-thread work, pathological material compilation, and non-finite/overflowing numeric input.
Their evidence is marked `reproduced` or `inferred`, never `observed`.

Every class records:

- a stable ID and semantic signature;
- the trigger and affected command/domain;
- the layer that must refuse or contain it;
- whether the editor remains healthy, becomes suspect, or is dead;
- an explicit recovery action;
- regression sources and runtime evidence; and
- an honest status: `resolved`, `mitigated`, `open`, or `external`.

“Resolved” is intentionally strict: the manifest contract requires at least one named regression
and at least one existing source file. “Mitigated” means a guard exists but the requested
editor-survival proof or coverage is incomplete. This report therefore makes no claim of universal
editor-crash immunity.

## Next evidence required

1. Re-run the deterministic classifier whenever the evidence window advances; any opaque unknown
   fingerprint fails the zero-unknown threshold until it receives a defensible semantic owner.
2. Add disposable-editor survival tests for PIE teardown/transaction retention, lifetime-escaping
   Python work, malformed frames, and every engine-assert preflight.
3. Add the missing `data_create` abstract-class preflight and a regression before changing
   `HCR-DATA-001` from open.
4. Treat a caught structured exception as a suspect session forever; the safe response is a
   minimal error and restart instruction, not continued post-processing.
5. Never overwrite observed counts
   with estimates from audit prose.
