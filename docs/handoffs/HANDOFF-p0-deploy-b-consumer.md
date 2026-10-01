# P0 Deploy B: product candidate handoff

**Candidate preparation; do not treat this as a published release or completed deployment.** The target is `v0.4.0-rc.2`, subject to remaining gates and coordinated release metadata alignment. No tag is created or certified by this document. P0 completion, main finalization and `v0.4.0` remain later acceptance work. See [Versioning](../VERSIONING.md) and the [historical A verification status](HANDOFF-p0-deploy-a-consumer.md#historical-provenance-and-verification-status).

## Source provenance and measured evidence

| Evidence | Source and result supplied by the controller |
| --- | --- |
| Native full gate | `d376c1625105367fde7a1cce1c57e55710b493f3`: 147 actual successes / 81 manifest names; opt-in RealPIE 1 |
| Packaging/build gate | Same native source: standalone BuildPlugin 169 actions, exit 0; two copied-host builds |
| Read-only save survival | `5aa1f7cb67d78880310cbf708a45fb6e0a678f41`: ordinary 36/36 and canary 1/1, with raw post-handler proof; separate from the full native gate |
| GB2 script and Node gate | `9d7de2ff887a3960f7815f28cc068605db5f7cd7`: independent source review Approved, focused ladder checks 58/58; Node 2,659 passed / one existing Windows skip across 225 files, with 16 SQLite warnings |
| Static/build checks | At the GB2 source above: typecheck, C++ lint (22 cpp / 155 entries), server build exit 0 |

These are measured results already supplied for their stated source; writing this document ran no runtime tests. The controller reconciled reuse of the `5aa1f7cb` survival evidence: the later native source changed only a test fixture and preserved the relevant product/harness bytes. The expected test inventory is not the success count. Current scripts and native gate provenance are distinct, and a future packaged integration must record matching plugin and Node build source.

The controller subsequently completed actual GUI B1–B6 / B9–B10: **8/8 passed, actual client exit 0**, on the verified disposable GUI host using script source `9d7de2ff` and native source `d376c162`, without unattended or null-RHI launch flags. Postflight reported no unsafe/Python-unhealthy state, no PIE, no building assets and zero dirty packages. Human B7/B8 are **UNPERFORMED**. Historical A3/A7b/A8, handoff approval and consumer verification remain pending. B6 used direct framed TCP and is not evidence of the Node environment route. Automated passes do not settle these remaining checks.

The three plugin `VersionName` fields and root/server package versions are not aligned to the target release in this pass. Their coordinated alignment and packaging provenance are separate pending work; the target label does not imply current fields or artifacts are rc2.

## User-visible changes

- **T4 — canonical ids:** granted leases use `lease_id` (`ls_<seq>_<mac12>`); queued tickets use `lq_<seq>_<mac12>`. Ids survive both redaction layers. Replies no longer expose the old `token` handle key. `ping.capabilities.lease_id` is true.
- **T5 — save protection:** a read-only package is refused before mutation with `package_read_only` and `make_writable_hint`. `blueprint_compile {save:false}` compiles without saving. Hayba never clears read-only flags. Plugin Python execution scopes unattended mode so read-only map saves return `False` rather than opening a modal; check the return value. This is scoped execution, not a globally unattended editor/GUI policy.
- **T6/T8 — enforcement and warning volume:** default `EnforcedForWrites` lets reads run and refuses conflicting writes with `lease_conflict`; owner-less writes while other agents are connected receive `owner_required`. Warning logs are rate-limited per key over 30 seconds and retain repeat counts.
- **T7 — lifetime:** qualifying active claims can be reused and touched on successful use; bound leases become orphaned on disconnect rather than being deleted immediately. Explicit renew/release and the capped orphan lifetime are described below.
- **T10 — user build Play veto:** approved default mode1 vetoes user Play during an asset build, with a user-only second-press override within 10 seconds. Modes0/2 and strict unsafe precedence are described below. T10 adds no registered automation test names.

T4's canonical ids and T8's default enforcement must ship together. Dependent clients must migrate before that coordinated protocol update. No reduced T7/T8 fallback is implied by this candidate.

## Caller identity and wire parameters

Use top-level envelope `owner` for stable identity and optional top-level `lease` for a granted lease id:

```json
{"cmd":"ping","id":"example-1","owner":"example-agent","params":{}}
```

Set Node MCP `HAYBA_AGENT_ID` to the intended stable owner. Node seeds its envelope lease only from explicit `HAYBA_LEASE_ID`; `HAYBA_LEASE` and `HAYBA_LEASE_TOKEN` are ignored with a diagnostic. An unknown/expired environment-seeded lease is dropped after the corresponding reply, so it does not poison later writes. A programmatically set lease has its own lifecycle.

Envelope identity and command parameters are different contracts. `lease_renew` / `lease_release` take canonical params `lease_id`. For `editor_batch`, explicitly passing params `lease_id` or permanent alias `lease` is recommended for a portable call; when neither supplies an id, the handler also supports a valid top-level envelope `lease` as the fallback. An absent envelope lease or envelope redaction marker cannot supply that fallback. Ids are coordination handles in editor memory, not a substitute for authentication.

### Deprecated aliases and redaction markers

`token` remains only a deprecated input alias on `lease_renew` / `lease_release`, with `deprecation` and an owner/command log line. A marker under canonical params `lease_id` is refused with `[lease_id_redacted]`. Conflicting canonical and deprecated values are ambiguous; send only `lease_id`.

An envelope `lease` redaction marker is treated as absent for effective-owner resolution and does not prove identity. The gate still reports the invalid marker (`lease_id_error: redaction_marker`, rate-limit reason `lease_handle_redacted`), warning in Advisory/read-permitting cases or refusing writes under enforcement. Do not interpret that behavior as a valid lease or an explicit batch id. An `editor_batch` with only an envelope marker proceeds, where the gate permits, to `[lease_id_required]`; a marker in its explicit params `lease_id` or `lease` is a separate `[lease_id_redacted]` refusal.

The narrow legacy deprecated-token marker release shim is compatibility behavior, not a recommended calling pattern. B retains the alias/shim. Removal requires all migration and integration prerequisites **and** seven working days with zero deprecated-input log lines; time alone is insufficient.

## Enforcement and Python access

Project Settings > Hayba MCP Toolkit > Lease Enforcement supports:

| Mode | Behavior |
| --- | --- |
| Off | Lease conflict checking disabled |
| Advisory | Command runs with `lease_warning`; other state/safety gates still apply |
| EnforcedForWrites | Default: reads run; conflicting writes or writes naming dead handles are refused |
| Enforced | As above, including refusal of reads naming dead handles |

Refusal precedence is missing explicit owner, unknown lease, then conflicting holder. A stable envelope owner or a valid lease proves caller identity; synthetic `conn:<id>` / `local` do not satisfy the explicit-owner requirement. Presence alone never extends a lease. Branch on `code` and structured `lease` detail, rather than error text. Each response retains its own warning/repeat information even when log output is suppressed.

Python classification fails closed. World Partition Python is world-scoped regardless of its declarations. Otherwise declared `resources` scope a mutation, `read_only:true` identifies a genuine read, and undeclared `python_run` conflicts globally with any other owner's lease. Read declarations are an assertion about the script's behavior, not a bypass for mutation.

**R1:** the 47 reviewed Python-backed Node read descriptors declare `readOnly:true` and send `read_only` (for example `actor_find`, `object_inspect`, `light_list`, `seq_inspect`). This is a static source count, not 47 additional runtime passes. `seq_open` and `niagara_capability_probe` are not covered. Caller-authored scripts do not inherit those declarations.

An undeclared Python step inside `editor_batch` remains subject to enforcement and can fail the batch at that step. Declare mutation resources on every applicable step, especially World Partition edits. Normal batch error cleanup releases loaded regions; sticky unsafe termination deliberately avoids region unload/GC in a damaged process. See [Lease access classes](../adr/0010-multi-agent-editor-leases.md#commands-have-an-access-class).

## Lease lifetime

Defaults are TTL 120 seconds, maximum 900 seconds, and bound connections. Reacquiring the same active, non-yieldable claims with matching owner, label and binding returns the same id (`reused:true`). An owner does not conflict with itself.

- A connection close or TCP server restart orphans bound leases and immediately drops that connection's queued tickets. Orphan expiry is **the earlier of original expiry and orphan time + 60 seconds**; it is not a new unconditional 60-second lifetime.
- Explicit `lease_renew {lease_id}` or owner-scoped `lease_renew {}` revives/rebinds orphans. Reconnect with the same stable owner and renew before writing. Ordinary traffic does not revive them.
- A successful command that passes every gate and uses an active held claim touches that lease. Reads, status polls and refused commands never touch it.
- `lease_release {all:true}` releases all the caller's leases and tickets. Prefer a precise canonical id when releasing only one claim. `bind_connection:false` claims continue by TTL/renewal rather than disconnect orphaning.
- Running batches retain their own keepalive behavior. A client's disconnect need not cancel the batch; lease loss, unsafe state or step failure does. `lease_adopt` is future Deploy C work, not a B command.

An orphaned asset claim retains build protection only until that capped expiry or explicit release. See [Lease table lifecycle](../adr/0010-multi-agent-editor-leases.md#the-lease-table-never-blocks).

## PIE and build controls

**R12:** the 18 read-like names in [Deploy A safe reads](HANDOFF-p0-deploy-a-consumer.md#known-limits-and-safe-reads) remain reads, allowed during PIE and not refused as writes under `EnforcedForWrites`. They still obey cause-specific unsafe restrictions. Unknown command classes fail closed.

**R13:** nobody drives/stops user PIE. Only the owning agent drives an agent PIE; any caller may stop an agent PIE with a warning. Authorized agent-PIE drive/stop commands bypass the lease gate so a later lease cannot deadlock the session; that does not grant control over user PIE. Running and queued PIE both pause batches/refuse non-safe commands. `pie_active` is preflight: nothing ran. `pie_blocked` reports loaded Blueprint errors without queuing a modal.

Asset builds use exclusive `asset:<path>` claims with stable owners, explicit build labels and reliable renew/release. Agent `editor_start_pie` counts all asset X claims, including its own, in enforcement modes other than Off. Release claims before agent Play. Asset-targeted compile/save checks another owner's claim; refusing modes answer `asset_busy`, Advisory reports a state warning.

`hayba.PIEBuildVeto` is live console configuration for the **user's build veto**:

| Value | Build behavior |
| --- | --- |
| 0 | Notification only |
| 1 | Approved default: veto; user second press within 10 seconds overrides the build veto |
| 2 | Strict veto, no override |

Unknown values fail toward veto. The mode1 override never grants an agent an override. With enforcement Off, an agent reaching the authorizer is still vetoed in modes1/2. Every allowed user Play clears the remembered double-press time. Sticky unsafe takes precedence and remains strict in every mode, with no switch or override; loaded Blueprint error guards also remain. UE5.7 authorizer behavior is explicitly unverified; current evidence does not establish cross-version runtime support. See [Build veto decision](../adr/0012-editor-state-guards.md#addendum-the-play-button-during-a-build-d7-p0-t10).

## Recovery and measurement

To roll back lease enforcement live, select Advisory in Project Settings and confirm `ping.capabilities.lease_enforcement` / `lease_status.enforcement` report `advisory`. If UI is unavailable, the supported restart fallback is:

```ini
[/Script/HaybaMCPToolkit.HaybaMCPDeveloperSettings]
LeaseEnforcement=Advisory
```

Place this product setting in `Config/DefaultHaybaMCP.ini`, then restart. `hayba.PIEBuildVeto 0` rolls build veto back to notification-only. Neither setting clears sticky unsafe, disables its Play veto or bypasses PIE/error guards. After unsafe/native-fault codes, stop mutation work and follow the cause-specific user notification. Rebuild-based rollback requires independently verified matching plugin/Node provenance and an authorized closed-editor window.

Use the [portable measurement guidance](HANDOFF-p0-deploy-a-consumer.md#portable-measurement-guidance) with explicitly selected logs. Count suppressed warning repeats. Observe unknown/expired-handle refusals, warnings per hour, successful batch jobs, read-only-save hints and deprecated-input/marker-shim usage separately. Acquire-call counts include queued polls and are not the exact granted-acquire denominator. A target such as zero first-hour unknown/expired lines is not a measured result. Keep integration logs and deployment records outside public handoffs.
