# Fab tools (guided hand-off): design spec

- **Date:** 2026-09-28
- **Branch:** `feat/fab-tools` (worktree `.worktrees/fab-tools`), based on `origin/main` at `a5ceaa40`.
- **Status:** design for implementation planning. The guided hand-off ("Stage 1") was approved by the maintainer on 2026-09-28. Stage 2 is not approved (section 2.2).
- **Depends on:** the P0 safety train, `docs/superpowers/specs/2026-09-28-p0-safety-train-design.md` on `fix/p0-safety`. This spec calls it "the P0 spec" and cites its tasks as T1 to T10.
- **Supported engines:** Unreal Engine 5.7+ (5.7 and 5.8 are both covered; they differ, see section 14).
- **Conventions:**
  - `P` = `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit`. `N` = `mcp-tools/hayba-mcp`.
  - Hayba line numbers are at `a5ceaa40` unless a citation says `@leases`, which means `d5a1a205`, the base of `fix/p0-safety`. The C++ under `unreal/` is unchanged between `d5a1a205` and the tip of `fix/p0-safety`.
  - `F57` / `F58` = `<engine>/Engine/Plugins/Fab/Source/Fab` in the UE 5.7 and UE 5.8 installs (Fab plugin 0.0.10 and 0.0.17, `Fab.uplugin`). `E57` / `E58` = `<engine>/Engine/Plugins/Online/EOSShared/Source/EOSShared`. A citation with only `F58` holds for 5.8; one that names both was checked in both.
  - "Wire command" means the string sent over the TCP socket. "Tool" means an MCP tool name. They are different namespaces (`CONTEXT.md:63-67`).
  - "The first consumer project" is the project that asked for these tools. It runs UE 5.8.

---

## 1. Summary

Hayba gets six Fab tools that drive Epic's own in-editor Fab plugin and never stand in for it.

- `hayba_fab_login_status` reports whether Fab is usable and whether a session is signed in. It counts accounts; it reads no credential.
- `hayba_fab_library_list` asks Fab to run its own library sync and reads the rows Fab stored.
- `hayba_fab_open` shows a listing or a search in Fab's own tab. It returns no search data.
- `hayba_fab_add_to_project` is a hand-off. Hayba opens the listing in Fab's tab. The person reads the licence and clicks **Add to Project**. A Hayba job watches the import and returns `imported_paths[]` and `unsaved_packages[]`, so the caller can post-process and save by pathspec.
- `hayba_fab_job_status` and `hayba_fab_job_cancel` follow and stop that job.

The editor side is a new optional satellite plugin, `unreal/HaybaMCPFab`, with seven wire commands. Hayba never saves, never accepts a licence, and never holds a token. The import logic is a pure state machine with an injected clock, tested against a fake backend. Live behaviour is settled by twelve probes that a person runs on a throwaway scratch project.

---

## 2. Goals, non-goals and success criteria

### 2.1 Goals

| # | Goal |
|---|---|
| G1 | Report Fab availability, version, session state and contract drift without reading any credential. |
| G2 | List the user's Fab library from the rows Fab itself synced, and say honestly when that sync failed. |
| G3 | Show a listing or a search in Fab's own tab, on request. |
| G4 | Watch an import that the person starts, and return the imported paths, the unsaved packages, and what Fab saved by itself. |
| G5 | Refuse or flag unsafe situations through the P0 pieces: `pie_active`, `editor_unsafe`, asset leases, read-only files. |
| G6 | Be testable without Fab, a network or an account: a fake backend and pure state machines. |

### 2.2 Non-goals

**Stage 2 is a non-goal: headless download, and search that returns data.** It is recorded here so nobody builds it by accident.

- Nothing in either engine turns a listing id into a download. The only entry point is `UFabBrowserApi::AddToProject(DownloadUrl, FFabAssetMetadata)` (`F58/Private/FabBrowserApi.cpp:77-211`, `F57/Private/FabBrowserApi.cpp:38`). Engine C++ never calls it. It is called by the Fab web page through the JavaScript bridge that Fab binds into its own browser (`F58/Private/FabBrowser.cpp:619`), and the page supplies the signed download URL.
- The only other source of that URL is Fab's web service, called with the user's bearer credential. A headless import would therefore put that credential inside Hayba's process. The rule for these tools is that no credential passes through Hayba.
- That web service is undocumented, and Fab's terms have not been reviewed for automated use.
- The Fab plugin has no search in either engine. Results exist only inside the page.

Stage 2 needs an explicit maintainer decision after a person has read Fab's terms. Two checks belong to it and are **not** run under this spec: that terms review, and any request to a Fab web endpoint made by Hayba.

Also out of scope:

- Download size before the click, byte-accurate progress, a real download cancel, and a caller-chosen target path. Fab owns all four (section 6.5).
- **Plugin installs and MetaHumans are out of scope for verification.** The watch job tolerates them (section 8), but no probe covers them and no success criterion depends on them.
- Saving anything. Accepting or pre-accepting a licence. Signing in on the user's behalf.
- Fab environments other than production, and the separate Quixel Bridge plugin.
- Platforms other than the Windows editor.

### 2.3 Success criteria

| # | Criterion | How it is checked |
|---|---|---|
| SC1 | For each import kind in section 2.4, on 5.8 and then 5.7, the job reaches `succeeded`, `imported_paths` equals the set of packages the import created (compared with a by-hand content listing), and `unsaved_packages` equals the dirty or not-yet-on-disk subset. | Probes P3 to P6, then the live ladder in section 16. |
| SC2 | On 5.8 in a fresh project, the first Megascans import reports the parent-material packages under `/Game/Fab/Materials` in `saved_by_fab`, not in `unsaved_packages`. | Probe P4. |
| SC3 | No response, progress record, job output or Hayba log line carries a token-shaped string. | `Hayba.Fab.Handler.ResponsesCarryNoTokenShapes`, the Node redaction test, and a grep of the scratch host's log after every probe. |
| SC4 | No Fab pump tick costs more than 5 ms of game-thread time. | The pump measures itself and reports `pump_budget_exceeded` as a warning; asserted in the fake-backend tests. |
| SC5 | Every refusal carries a top-level `code` that Node knows. | `fab-contract.test.ts` (section 12.3). |
| SC6 | With the engine's Fab plugin disabled, the core toolkit still loads and every Fab tool answers `fab_satellite_missing` with a hint. | Scratch host check in section 16, and `fab-unknown-command.test.ts`. |
| SC7 | Every automation test named in section 12.2 reports Success under the filter `Hayba`, checked by exact name. | The manifest check in section 12.4. |
| SC8 | When Fab's own library sync fails, `hayba_fab_library_list` answers `ok:false` with `fab_library_sync_failed`. It never presents an empty list as an empty library. | `Hayba.Fab.Handler.LibraryReadAfterFailedSyncIsNotEmptySuccess`, and probe P9. |

### 2.4 First-consumer priorities (binding for ordering)

Build, probe and verify in this order.

1. **glTF/FBX imports, and Megascans 3D imports.** The Megascans check includes the parent materials that a Megascans import copies to `/Game/Fab/Materials` and auto-saves on 5.8.
2. **Megascans surfaces.**
3. **UE packs** (low priority).

Plugins and MetaHumans are not verified.

For `hayba_fab_add_to_project` the core contract is two keys, `imported_paths[]` and `unsaved_packages[]`. They are present in every status reply of an import job, they are always arrays, and they are never renamed.

---

## 3. What exists today (verified)

### 3.1 Hayba

**Satellites: how they are declared and found.**

- A satellite is its own plugin next to the toolkit under `unreal/`. Its `.uplugin` has one Editor module with `LoadingPhase: PostEngineInit` (`unreal/HaybaMCPGAS/HaybaMCPGAS.uplugin:12-18`) and lists `HaybaMCPToolkit` plus the engine plugin it wraps as dependencies (`:19-22`). `HaybaMCPMetaSound.uplugin` has the same form.
- Its `Build.cs` links `HaybaMCPToolkit` privately (`unreal/HaybaMCPGAS/Source/HaybaMCPGAS/HaybaMCPGAS.Build.cs:13-24`).
- At `StartupModule` it loads the core module and registers one handler (`unreal/HaybaMCPGAS/Source/HaybaMCPGAS/Private/HaybaMCPGASModule.cpp:19-27`) through `FHaybaMCPModule::RegisterExternalHandler`, which is exported (`P/Public/HaybaMCPModule.h:97-103`, `P/Private/HaybaMCPModule.cpp:565-573`).
- The router adds every name from the handler's `GetCommands()` to its command map (`P/Private/HaybaMCPCommandHandler.cpp:1102-1111`).
- The editor finds a satellite only when it is installed in the host project's `Plugins/` folder. When it is absent, its commands answer `Unknown command` (`P/Private/HaybaMCPCommandHandler.cpp:1366-1379`), and the sidecar notes say so (`N/src/legacy-commands/sidecar.json:5314`).
- Node does no discovery. Two static checks know satellites through hard-coded lists: `N/src/tools/no-stub-wrappers.test.ts:29-33` lists the satellite handler folders, and `N/src/tools/__tests__/wire-command-names.test.ts:30` scans only the core toolkit's source.
- A satellite must add capability that the always-available tool surface cannot reach (`docs/adr/0008-satellite-plugins-earn-their-place.md`). Fab qualifies: Python cannot count EOS accounts, read the editor data storage rows, or watch Fab's cache, and Fab is optional per project.

**Handlers run on the game thread.**

- The TCP server drains queued commands from a core ticker, not from a task-graph task (`P/Private/HaybaMCPTcpServer.cpp:248-254`, `:546-555`). The comment there records why: a handler that re-enters the task graph inside `AsyncTask(GameThread)` crashes.
- A handler that marshals to the game thread and waits deadlocks itself (`P/Public/HaybaMCPGameThread.h:15-21`).
- A modal dialog on the game thread stops every command until a person answers (`P/Public/HaybaMCPAssetGuard.h:3-10`).
- Long work is a job pumped by `FTSTicker::GetCoreTicker()` (`P/Private/handlers/HaybaMCPTestHandler.cpp:172-180`).

**The job registry, as it is.**

- `FHaybaMCPJobRegistry` lives in `P/Private/HaybaMCPJobRegistry.h`. It has two statuses, `Running` and `Done` (`:22-26`).
- A job's state is `JobId`, `OpName`, `Status`, `StartedAt`, `FinishedAt`, `ExitCode`, `Output` and `bFound` (`:28-38`).
- The API is `AllocateJob`, `SetDone`, `RestoreRunningJob` and `GetJob` (`:46-59`), all under one lock (`:64`).
- The class is **not exported** (`:40` has no `HAYBAMCPTOOLKIT_API`) and the header is **private**. A satellite cannot include it or link against it today.
- Nothing removes a job (`P/Private/HaybaMCPJobRegistry.cpp:12-25` adds; no function erases).
- The only reader in this tree is `build_status` (`P/Private/handlers/HaybaMCPBuildHandler.cpp:285-360`). It returns `running`, or `done` with `ok = exit_code == 0`. The lease feature adds a second reader, `batch_status` (`P/Private/handlers/HaybaMCPBatchHandler.cpp:801` `@leases`).
- The registry is identical on `fix/p0-safety`. It is existing core code, not something the P0 train adds.

**Redaction exists on both sides.**

- Editor: every response passes `RedactFinalEnvelope` just before it is serialized (`P/Private/HaybaMCPCommandHandler.cpp:1059-1067`). Its patterns include `Bearer …` and JWTs (`P/Private/HaybaMCPSecretRedaction.cpp:471-472`). `RedactTextForLog` exists for log text (`P/Private/HaybaMCPSecretRedaction.h:48-51`). That header is private.
- Node: `redactMcpResult` (`N/src/security/secret-redaction.ts:209-220`) with the same two patterns (`:157-158`) and an assignment pattern that masks the value after words such as `token:` (`:164-165`).
- Neither side has a pattern for the `eg1~` prefix.

**The five layers for a new wire command, as they are in this tree.**

| Layer | File | What checks it |
|---|---|---|
| 1. Declare and implement | the handler's `GetCommands()` and `Handle()` | `wire-command-names.test.ts:43-55` collects `TEXT("…")` literals and sidecar keys |
| 2. Sidecar descriptor | `N/src/legacy-commands/sidecar.json` (`params`) | `N/scripts/check-legacy-wrappers.mjs:4-12` |
| 3. `returns` on that entry | same file (`LegacyCommandEntry.returns`, `N/src/legacy-commands/index.ts:56-64`) | the sidecar description tests |
| 4. `agent_callable` and `has_ts_wrapper` | same file; `isLegacyTarget` builds a generated tool only for `agent_callable && !has_ts_wrapper` (`N/src/tools/legacy-tool-factory.ts:44-46`, `:189-206`) | `check-legacy-wrappers.mjs:147-161` compares `has_ts_wrapper` with the literal `executeCommand('<name>')` calls |
| 5. `list-tool-categories` | `N/src/tools/code-mode/list-tool-categories.ts` (`DOMAINS` at `:31`, `domainOf` at `:233-252`) | the guard that every registered tool appears in its output |

Raw TCP works after layer 1, so a command looks finished long before an agent can reach it.

**The dead Fab tools.**

- `origin/main` still registers four tools that call commands no handler implements: `N/src/tools/fab/{login-status,library-list,marketplace-search,download}.ts`, `N/src/tools/index.ts:50-53` and `:3315-3367`, `N/src/tools/routing/packs.yaml:29-32`, `N/src/tools/schema-single-source.test.ts:111-145`, and the exemption list in `wire-command-names.test.ts:97-105`.
- They are removed on `fix/p0-safety` by commits `3555081d`, `394a4f00` and `57b832af`. That removal also dropped the `hayba_fab_` rule from `inferDir()` (`N/src/tools/index.ts:3972` here) and from `domainOf()` (`list-tool-categories.ts:236` here).

### 3.2 The engine's Fab plugin

| Fact | Where |
|---|---|
| The module starts only in an interactive editor, not in a commandlet. On 5.8 it also skips its own start-up when the `Emporium` plugin is enabled. | `F58/Private/FabModule.cpp:51-60`; 5.7 has no Emporium check (`F57/Private/FabModule.cpp:51`) |
| Fab signs in only when a tab opens: `LoginUsingPersist()` is called from tab creation. | `F58/Private/FabBrowser.cpp:335-337`; `F57/Private/FabBrowser.cpp:275-277` |
| Fab creates its EOS platform through the options overload, which leaves the platform's config name empty. | `F58/Private/FabAuthentication.cpp:100`; `E58/Private/EOSSDKManager.cpp:654-664` sets the name only in the named overload, `:666-716` is the options overload |
| Active platforms can be listed through a public interface. | `E58/Public/IEOSSDKManager.h:134`, `E58/Private/EOSSDKManager.cpp:718-735` (same in `E57`) |
| Fab's auth handle is set only inside its login functions. | `F58/Private/FabAuthentication.h:111`, `F58/Private/FabAuthentication.cpp:268`, `:298`, `:324` |
| `EOSSDK INFO` logs the access and refresh values in non-shipping builds. | `E58/Private/EOSSDKManager.cpp:1227-1230`, `:1357-1365`; `E57` `:1222-1225`, `:1352-1360` |
| Console commands: `Fab.ShowSettings`, `Fab.Logout`, `Fab.Login`, `Fab.ClearCache`, `Fab.SetEnvironment`, `Fab.TEDS.MyFolderIntegration [batch]`. | `F58/Private/FabConsoleCommands.cpp:12-89` (same names in `F57`) |
| The library sync removes every row first, then requests `{base}/e/accounts/{id}/ue/library?count=N` with Fab's own credential and follows `cursors.next`. The file is byte-identical in 5.7 and 5.8. | `F58/Private/Teds/FabMyFolderIntegration.cpp:31-41`, `:43-85`, `:105-114` |
| The sync logs distinct lines: not signed in (`:83`), a response arrived (`:91`), a page was parsed (`:162`), and five separate errors (`:166`, `:171`, `:176`, `:181`, `:186`). The error at `:166` prints the whole response body. | same file |
| Rows go to the editor data storage table `Fab` with a name column, a Fab object column and a URL column. | `F58/Private/Teds/FabMyFolderIntegration.cpp:21-24`; columns at `F58/Private/Teds/FabMyFolderIntegration.h:38-72` |
| The Fab object and name columns are declared in a private Fab header. The URL and web-image columns are public engine types. | `<engine>/Engine/Source/Runtime/TypedElementFramework/Public/Elements/Columns/TypedElementWebColumns.h:13-48` |
| The editor data storage plugins are marked experimental. | `<engine>/Engine/Plugins/Experimental/EditorDataStorage/EditorDataStorage.uplugin:15` |
| Fab records imports in `UFabLocalAssets.PathsListingID`, a config map from a `/Game` folder to an id, stored in `EditorPerProjectUserSettings`. The write prunes and saves on a task-graph thread. | `F58/Private/Utilities/FabLocalAssets.h:14-21`, `:25-53` (identical in `F57`) |
| "View in Fab" builds `<base>/plugins/ue5/listings/<id>` from that recorded id. | `F58/Private/FabBrowser.cpp:223`, `:956-975`; `F57/Private/FabBrowser.cpp:192`, `:245-268` |
| The cache location is `UFabSettings.CacheDirectoryPath`. `FFabAssetsCache` is exported. | `F58/Private/Utilities/FabAssetsCache.cpp:29-32`, `F58/Public/Utilities/FabAssetsCache.h:9-23` (identical in `F57`) |
| An HTTP download streams to `<file>.download`. A cached file is reused and the request is cancelled. | `F58/Private/FabDownloader.cpp:82-86`, `:95-113` |
| Packs download through BuildPatch: staged under `<cache>/<AssetId>`, installed into the project folder. | `F58/Private/FabDownloader.cpp:312-315`, `F58/Private/Workflows/PackImportWorkflow.cpp:33-44` |
| Fab's download queue is private. Only the pack notification has a Cancel button. | `F58/Public/FabDownloader.h:112-121`, `F58/Private/Workflows/PackImportWorkflow.cpp:312-353` |
| `AddToProject` logs `Add listing to project - <id>` and `Listing type - <type>`, and ignores a listing that is already being processed. | `F58/Private/FabBrowserApi.cpp:80-90`; `F57/Private/FabBrowserApi.cpp:50-51` |
| `UFabBrowserApi` exposes `GetAuthToken` and `GetRefreshToken` as reflected functions. `UFabSettings` has a `CustomAuthToken` property. Fab's EOS client settings live in the asset `/Fab/Data/FabEos`. | `F58/Private/FabBrowserApi.h:143-147`, `F58/Private/FabSettings.h:54-56`, `F58/Private/FabAuthentication.cpp:30` |
| `FabModule.h` defines the global macro `MS_MODULE_NAME`. | `F58/Public/FabModule.h:7` |

What each import kind does, from source. The probes confirm it.

| Kind | Workflow | Assets land in | Fab's recorded key | Saved by Fab? |
|---|---|---|---|---|
| glTF, GLB, FBX | `FGenericImportWorkflow` | `/Game/Fab/<Name>` (`F58/Private/Workflows/GenericImportWorkflow.cpp:204-209`) | the same folder (`:219`) | No. The import task uses `bSave = false` (`F58/Private/Importers/GenericAssetImporter.cpp:144`, `F57` `:143`) |
| Megascans: 3D, Plants, Decals, Imperfections, Surfaces | `FQuixelImportWorkflow` | `/Game/Fab/Megascans/<SubType>/<Name>_<MegascanId>/<Tier>` (`F58/Private/Workflows/QuixelImportWorkflow.cpp:325`) | the parent of the tier folder (`:336`) | No for the asset (Interchange). On 5.8 the parent materials are copied and auto-saved (next row) |
| Megascans parent materials, 5.8 only | `CopyMaterialsToProject` | `/Game/Fab/Materials` | none | Yes: `AdvancedCopyPackages(..., bForceAutosave = true, ...)`, then the Megascans parent settings are rewritten and saved. It runs only when `Content/Fab/Materials` does not exist (`F58/Private/Workflows/QuixelImportWorkflow.cpp:220-312`). 5.7 has no such step |
| UE pack | `FPackImportWorkflow` | `/Game/<PackFolder>` (`F58/Private/Workflows/PackImportWorkflow.cpp:295-304`) | the same folder | Files are written to disk directly. On 5.8 a notification may offer "Enable Missing and Restart" (`:68-195`) |
| MetaHuman | `FMetaHumanImportWorkflow` | `/Game/Fab/MetaHuman` (`F58/Private/Workflows/MetaHumanImportWorkflow.cpp:58-69`) | none: it never records an entry | not verified |
| Plugin, 5.8 only | `FPluginInstallWorkflow` | the engine or project plugin folder | none | out of scope |

Two hazards Hayba inherits and cannot prevent:

- A `.rar` inside a generic archive raises a **modal** dialog (`F58/Private/Workflows/GenericImportWorkflow.cpp:82-94`).
- A Megascans import with an unknown sub-type logs an error and never completes (`F58/Private/Workflows/QuixelImportWorkflow.cpp:367-370`). Fab then refuses the same listing again, because the workflow stays in its active list (`F58/Private/FabBrowserApi.cpp:80-87`).

### 3.3 What the P0 train provides

These pieces are reused by their P0 names. None of them exists in this worktree yet.

| P0 piece | P0 spec | How the Fab tools use it |
|---|---|---|
| `pie_active` refusal | T2, router slot 2. `PieRuleFor` defaults to Refuse | The router refuses `fab_open`, `fab_library_sync` and `fab_import_watch_start` during PIE. Nothing needs to be listed for that: it is the default |
| `editor_unsafe` and `editor_unsafe_restart_required` | T1, router slot 1, allowlist fails closed | The router refuses every Fab command except the two job commands. The job pumps stop themselves (section 10.3) |
| Asset leases, `asset:<path>` | T3 (seam S1, `AssetWriteCommands`), D5, `FindAssetHolders` | The import job holds `asset:/Game/Fab` exclusively for its lifetime, so `editor_get_state.building` lists it and an agent's `editor_start_pie` answers `asset_busy` |
| `package_read_only` preflight | T5, `HaybaSaveVerify::FindReadOnlyPackageFiles` in `Public/HaybaMCPSaveVerify.h` | The import preflight lists read-only files as warnings. The Fab tools never save, so they never emit the code. The caller meets it later, when it saves `unsaved_packages` |
| The shared command sets | T1 / R12, `P/Private/HaybaMCPCommandSets.h` | Four Fab commands are added to the read and status sets (section 6.0) |
| `IsWireRefusalCode` and `MakeGateRefusal` | T5 and T1, section 3.0 of the P0 spec | Handler refusals use the structured `Ok(Data{ok:false, code, …})` channel (P0 ruling R3) |
| `KNOWN_UE_CODES` | T1 onwards | The Fab codes are added to it |
| The job registry | existing core code (section 3.1) | Extended with progress and a cancel flag (section 10) |

### 3.4 Branch reality

- `origin/main` at `a5ceaa40` contains neither the lease feature nor the P0 train. `d5a1a205` is not an ancestor of `a5ceaa40`; their merge base is `5c4aefed`.
- This worktree therefore has no `HaybaMCPLeaseManager`, no `HaybaMCPAccessPolicy.h`, no `HaybaMCPBatchPolicy.h` and no ADR-0010.
- The pure batch machine that the watch machine is modelled on, `HaybaMCPBatch::FMachine`, exists only `@leases` (`P/Private/HaybaMCPBatchPolicy.h:228-247`).
- The implementation branch is rebased onto the trunk after the P0 train has merged (section 16). This spec is written against that future tree and says so wherever it matters.

---

## 4. Decisions this spec makes

| # | Decision | Reason |
|---|---|---|
| D-F1 | The new tools land **after** the removal of the four dead registrations, and the new wire commands do **not** reuse the dead wire names `fab_login_status`, `fab_library_list`, `fab_marketplace_search`, `fab_download`. | Those names mean "a command that never existed". A test asserts none of them is declared, called or in the sidecar (section 12.3) |
| D-F2 | Two tool names are reused on purpose, `hayba_fab_login_status` and `hayba_fab_library_list`, with new behaviour and new shapes. `hayba_fab_marketplace_search` and `hayba_fab_download` are not registered. | One name per capability. `hayba_fab_add_to_project` replaces the download tool; `hayba_fab_open` replaces search in Stage 1 |
| D-F3 | The core exports a small seam for satellites (section 5.6). The job registry header moves to `Public/` and the class is exported. | A satellite builds only against the core's public headers, and the registry is private and unexported today |
| D-F4 | Command policy stays in the core's central tables. A satellite does not declare its own access class or PIE rule. | P0 ruling R12: one read list. Anything not listed fails closed |
| D-F5 | `fab_library_sync` and `fab_open` are **not** added to the read sets. After P0 T8 they classify as `WriteScoped` without resources, and they are refused during PIE. | They start a network request or change the editor's UI. Failing closed costs little: neither is useful during PIE |
| D-F6 | The import job **holds** an exclusive lease on `asset:/Game/Fab` while it runs. | P0 decision D5: work that writes assets marks itself busy by holding `asset:<path>`. It makes the import visible to other agents and to the PIE guards |
| D-F7 | That lease is a **marker**. It does not cover assets below `/Game/Fab`. | Asset keys are flat: `asset:<path>` is its own node directly under `global` (`P/Private/HaybaMCPAccessPolicy.h:193-205`, `:209-218` `@leases`), and a conflict needs the same key (`:431-456` `@leases`) |
| D-F8 | The import start does **not** refuse when the session reads `not_signed_in`. It opens the Fab tab, adds the warning `not_signed_in`, and lets the person sign in on Fab's page as part of the hand-off. | A fresh editor always reads `not_signed_in` until a Fab tab opens (section 3.2). A refusal would fail the first call in every session |
| D-F9 | `fab_library_sync` **does** refuse with `not_signed_in` unless the session reads `signed_in`, or reads `unknown` while a Fab tab is open. | Before the first tab opens, Fab's auth handle is unset, and the sync would pass it to EOS as it is (`F58/Private/Teds/FabMyFolderIntegration.cpp:45`) |
| D-F10 | Fab's log lines are never returned as text. Known lines map to event codes; everything else is counted. | `LogFab` can carry a whole server response (`FabMyFolderIntegration.cpp:166`) and a client id (`F58/Private/FabAuthentication.cpp:358`) |
| D-F11 | Hayba builds every Fab URL itself from a parsed id or query. Caller text is never loaded in Fab's tab. | That browser has Fab's bridge bound to it, and the bridge exposes the credential getters to the page (section 3.2) |
| D-F12 | Only one import job runs at a time. | Cache growth and registry changes cannot be attributed to one of two concurrent imports |
| D-F13 | None of the seven commands is Plan-Mode gated or wrapped in an editor transaction. | Hayba mutates nothing. The person performs the import |
| D-F14 | The satellite links the `Fab` module for one exported class, `FFabAssetsCache`. Everything else is found by reflection path and feature-detected. | An exported function is a build-time contract. Reflection paths can drift silently, so they are probed and reported |

---

## 5. The satellite plugin `HaybaMCPFab`

### 5.1 Layout

```text
unreal/HaybaMCPFab/
  HaybaMCPFab.uplugin
  Source/HaybaMCPFab/
    HaybaMCPFab.Build.cs
    Private/
      HaybaMCPFabModule.cpp        registers the handler into the core router; removes pumps on shutdown
      HaybaMCPFabHandler.h/.cpp    the seven commands: parse, preflight, shape. No engine Fab calls
      HaybaFabBackend.h            IHaybaFabBackend and its value types (section 12.1)
      HaybaFabPluginBackend.h/.cpp the production backend
      HaybaFabContract.h/.cpp      feature detection (section 5.5)
      HaybaFabWatchPolicy.h        pure: FWatchMachine and FSyncMachine (sections 8 and 9)
      HaybaFabListing.h            pure: parse a listing, build URLs (section 6.4)
      HaybaFabLogEvents.h          pure: map a LogFab line to an event code (section 11.7)
      HaybaFabScrub.h              pure: scrub token-shaped strings (section 11.6)
      HaybaFabJobs.h/.cpp          the two ticker pumps (section 10.3)
      Tests/                       section 12.2
```

### 5.2 `.uplugin`

The same form as `HaybaMCPGAS.uplugin`.

```json
{
  "FileVersion": 3,
  "Version": 1,
  "VersionName": "0.1.0",
  "FriendlyName": "Hayba MCP - Fab",
  "Description": "Optional Fab (fab_*) command satellite for HaybaMCPToolkit. It drives the engine's own Fab plugin and never handles credentials. Disabled together with the engine's Fab plugin, leaving the core plugin to load normally.",
  "Category": "Editor",
  "CreatedBy": "Hayba",
  "EnabledByDefault": true,
  "CanContainContent": false,
  "Installed": false,
  "Modules": [
    { "Name": "HaybaMCPFab", "Type": "Editor", "LoadingPhase": "PostEngineInit" }
  ],
  "Plugins": [
    { "Name": "HaybaMCPToolkit", "Enabled": true },
    { "Name": "Fab", "Enabled": true },
    { "Name": "EOSShared", "Enabled": true }
  ]
}
```

Fab loads at `PostDefault` (`<engine>/Engine/Plugins/Fab/Fab.uplugin`, the `LoadingPhase` of its module), which is before `PostEngineInit`.

### 5.3 Module dependencies

| Module | Why | Link or reflection |
|---|---|---|
| `HaybaMCPToolkit` | `IHaybaMCPHandler`, the router registration, the satellite seam, the job registry | link, public headers only |
| `Core`, `CoreUObject`, `Engine`, `UnrealEd` | reflection, `GEditor` for the PIE check | link |
| `Json`, `JsonUtilities` | shapes | link |
| `AssetRegistry` | registry change delegates, package state | link |
| `Slate`, `SlateCore`, `ToolMenus`, `LevelEditor` | find or open the Fab tab | link |
| `WebBrowser` | `SWebBrowser::LoadURL` and `GetUrl` (`<engine>/Engine/Source/Runtime/WebBrowser/Public/SWebBrowser.h`) | link |
| `Projects` | `IPluginManager` for plugin state and version | link |
| `EOSShared`, `EOSSDK` | `IEOSSDKManager::GetActivePlatforms`, account counts | link |
| `TypedElementFramework` | `ICoreProvider`, the URL and web-image columns | link |
| `Fab` | `FFabAssetsCache` only (`Utilities/FabAssetsCache.h`) | link |
| Fab settings, local assets, library columns, console command, tab entry points | | reflection path or name lookup, feature-detected |

### 5.4 Source hygiene

- Include no private Fab header. They are not on the include path, and that is the point.
- Do not include `FabModule.h`. It defines a global macro (`F58/Public/FabModule.h:7`). Ask `FModuleManager::Get().IsModuleLoaded("Fab")` instead, which is all `IFabModule::IsAvailable` does (`:17-20`).
- Do not subclass `IFabWorkflow`. Its base class differs between 5.7 and 5.8 (section 14).
- The identifiers in section 11.2 never appear in the satellite's source. A Node test scans for them.

### 5.5 Feature detection

`FHaybaFabContract::Probe()` runs on the first Fab command and on every `fab_status`. It reads names and shapes. It never reads a value that could be a credential.

| Contract item | What is checked | Needed by |
|---|---|---|
| `fab_module` | module `Fab` is loaded | everything |
| `fab_version` | `IPluginManager` finds plugin `Fab` with a version name | `fab_status` |
| `settings_class` | class `/Script/Fab.FabSettings` exists | the next three |
| `quality_tier_property` | enum property `PreferredQualityTier` | the `quality_tier_raw` warning |
| `cache_directory_property` | struct property `CacheDirectoryPath` | cache measurement |
| `environment_property` | enum property `Environment` | URL building |
| `local_assets_class` | class `/Script/Fab.FabLocalAssets` with map property `PathsListingID` | attribution, `in_project` |
| `library_columns` | structs `/Script/Fab.FabObjectColumn` (with `AssetId`, `AssetNamespace`, `ListingType`, `Seller`, `Source`) and `/Script/Fab.FabObjectNameColumn` (with `Name`) | `fab_library_read` |
| `library_sync_command` | console object `Fab.TEDS.MyFolderIntegration` is registered | `fab_library_sync` |
| `data_storage` | the editor data storage feature is available | the library commands |
| `eos_manager` | `IEOSSDKManager::Get()` is non-null and initialized | the session |
| `tab_entry_point` | 5.7: tab spawner `FabTab` is registered. 5.8: tool-menu entry `OpenFabTab` exists in `MainFrame.MainMenu.Window` | opening a tab |
| `browser_widget` | checked lazily: an open Fab tab contains an `SWebBrowser` | in-editor navigation |

Reporting:

- `fab_status.contract` is `{ "ok": bool, "fab_contract_changed": ["<item>", …] }`.
- A command that needs a missing item refuses with code `fab_contract_changed` and `missing: ["<item>", …]`.
- A command that can work without the item runs, and adds the warning `fab_contract_changed` with the same list. The import watch degrades this way: without `cache_directory_property` it reports `observed.cache_measured: false`; without `local_assets_class` its attribution is `unconfirmed`.
- One smoke test runs the real probe on the engine under test and expects an empty list (section 12.2). It needs no sign-in and no network.

### 5.6 Core companion changes

These are changes to `HaybaMCPToolkit`. They ship in the same train as the satellite.

| # | Change | File |
|---|---|---|
| C1 | Move the job registry header to `P/Public/HaybaMCPJobRegistry.h`, export the class, and extend it (section 10). | `P/Public/HaybaMCPJobRegistry.h`, `P/Private/HaybaMCPJobRegistry.cpp`, `handlers/HaybaMCPBuildHandler.cpp` |
| C2 | New public header `P/Public/HaybaMCPSatelliteHost.h`, namespace `HaybaMCPSatelliteHost`, every function exported. | new |
| C3 | Add four Fab commands to the shared command sets and one constant-key row to `AssetWriteCommands` (section 6.0). Teach the drift tests about satellite commands. | `P/Private/HaybaMCPCommandSets.h`, `P/Private/HaybaMCPAccessPolicy.h`, the P0 drift tests |
| C4 | Add the Fab refusal codes to `IsWireRefusalCode`. | `P/Private/HaybaMCPCommandHandler.cpp` |
| C5 | Add an `eg1~` pattern to both redaction layers. | `P/Private/HaybaMCPSecretRedaction.cpp`, `N/src/security/secret-redaction.ts` |
| C6 | `editor_run_console_command` refuses any command whose first word is `EOSSDK`, with code `console_command_refused`. | `P/Private/handlers/HaybaMCPEditorHandler.cpp:464-479` has no check today |
| C7 | `editor_get_output_log` and `editor_stream_log` drop lines whose category is `LogEOSSDK`, and report `dropped_lines`. | `P/Private/handlers/HaybaMCPEditorHandler.cpp:482-510`, `:596-625` return raw lines today |

The seam C2 contains exactly this:

```cpp
namespace HaybaMCPSatelliteHost
{
    /** P0 T1: true once a native fault was contained. Sticky until restart. */
    bool IsEditorUnsafe();

    /** The effective owner of the command being dispatched. Empty outside a dispatch. */
    FString CallerOwner();

    /** An in-process, unbound lease for a job. Never waits. Returns false with the holder when refused. */
    bool AcquireJobLease(const FString& Owner, const TArray<FString>& Resources, const FString& Label,
                         double TtlSeconds, FString& OutLeaseId, FString& OutHolderOwner);
    bool RenewJobLease(const FString& LeaseId, const FString& Owner, double TtlSeconds);
    void ReleaseJobLease(const FString& LeaseId, const FString& Owner);

    /** Forwards to HaybaMCPSecretRedaction::RedactTextForLog. */
    FString RedactTextForLog(const FString& Input, int32 MaxChars = 4096);

    /** Forwards to the core's one structured-exception guard, so a fault is recorded by P0 T1. */
    void RunGuarded(void (*Thunk)(void*), void* Context, bool& bOutCrashed);
}
```

Rules for the seam:

- It adds no field to `FHaybaHandlerResult` and changes no existing public type (P0 ruling R3).
- `CallerOwner` exists because `IHaybaMCPHandler::Handle` receives only the command and its params (`P/Public/IHaybaMCPHandler.h:45-46`).
- `RunGuarded` exists because the core's guard is declared in a public header but not exported (`P/Public/HaybaMCPSeh.h:19-21`), and because a ticker pump runs outside the router's guard. The satellite adds no guard of its own: P0 T1 keeps exactly one in the toolkit.
- A lease id returned by `AcquireJobLease` stays inside the editor process. It is never put in a response.
- C1 changes a class layout. It needs a full rebuild with the editor closed; Live Coding cannot apply it.

**Drift tests and satellites (C3).** The P0 drift tests require every listed name to be a registered command. A satellite's commands are unregistered whenever the satellite is not installed. `HaybaMCPCommandSets.h` therefore gains `SatelliteCommands()`, a map from command name to satellite module name. A drift test accepts a listed satellite command when it is registered, **or** when its satellite module is not loaded.

---

## 6. Wire commands

Handler domain: `fab`. Handler class: `FHaybaMCPFabHandler`.

### 6.0 Common rules

**Classification.** "Default" means the command is listed nowhere, so P0's fail-closed rules apply.

| Command | Access class after P0 T8 | During PIE | While `editor_unsafe` | Node retry on transport failure |
|---|---|---|---|---|
| `fab_status` | Read (`ReadCommands()`) | allowed | refused | allowed |
| `fab_library_sync` | WriteScoped, no resources (default) | `pie_active` (default) | refused | never (`NON_IDEMPOTENT`) |
| `fab_library_read` | Read (`ReadCommands()`) | allowed | refused | allowed |
| `fab_open` | WriteScoped, no resources (default) | `pie_active` (default) | refused | allowed |
| `fab_import_watch_start` | WriteScoped, implied exclusive claim on `asset:/Game/Fab` (constant-key row in `AssetWriteCommands`) | `pie_active` (default) | refused | never (`NON_IDEMPOTENT`) |
| `fab_job_status` | Read (`StatusOnlyCommands()`) | allowed | allowed | allowed |
| `fab_job_cancel` | Read (`StatusOnlyCommands()`) | allowed | allowed | allowed |

- The two job commands qualify for `StatusOnlyCommands()` because they touch only the job registry. They never resolve a `UObject`.
- `fab_status` and `fab_library_read` are not in P0's `UnsafeReads`, so the unsafe gate refuses them.
- A WriteScoped command without resources takes only intent locks on the world and on `global` (`P/Private/HaybaMCPAccessPolicy.h:470` `@leases`). It collides with another owner that holds the world or everything exclusively, and with nothing else.
- None of the seven is in `IsDestructiveCommand` (`P/Private/HaybaMCPCommandHandler.cpp:399`). D-F13.

**Gate order.** The router's gates run first, in the P0 order: auth, `editor_unsafe_restart_required`, `pie_active`, `asset_busy`, the lease gate. The handler's own preflight runs after them.

**Refusal channel.** A handler refusal is `Ok(Data{ok:false, code, error, phase:"preflight", mutation_status:"not_started", …detail})`. The router promotes `data.code` to the envelope's top-level `code` (P0 T5, `IsWireRefusalCode`). The data object of every Fab refusal has this form:

```jsonc
{
  "ok": false,
  "code": "fab_unavailable",                 // one of the codes in section 15
  "error": "fab_unavailable: 'fab_open' was not run: the editor's web browser cannot start, so Fab's tab cannot show a page.",
  "phase": "preflight",
  "mutation_status": "not_started",
  "command": "fab_open",
  "reason": "web_browser_unavailable",
  "hint": "Enable the Web Browser plugin (Edit > Plugins), restart the editor, then call again."
  // plus the detail keys listed per code in section 15
}
```

**Key and text rules.** They keep both redaction layers from mangling a reply.

- No key ends in a secret word: token, secret, password, passwd, pwd, credential, cookie, authorization, or a `*key` compound. This is the P0 T4 rule, applied to the Fab protocol.
- No fixed text (hint, note, warning, `user_action`) contains one of those words followed by `:` or `=`.
- Listing ids and library row ids are lower-case. A job id is the registry's GUID, in the form the registry gives it (`P/Private/HaybaMCPJobRegistry.cpp:14`), and is compared without regard to case.
- Arrays are bounded: at most 512 paths, 20 read-only files, 32 warnings. A reply that was cut sets `truncated: true`.

### 6.1 `fab_status`

Params: `{}`.

```jsonc
{
  "fab_available": true,
  "reason_unavailable": null,        // "fab_disabled" | "emporium" | "commandlet" | "web_browser_unavailable" | "non_production_environment"
  "fab_version": "0.0.17",           // null when unavailable
  "engine_version": "5.8.0",
  "session": "signed_in",            // "signed_in" | "not_signed_in" | "unknown"
  "session_detail": { "platforms": 1, "unnamed_platforms": 1, "signed_in_accounts": 1 },
  "fab_tab_open": true,
  "quality_tier": "medium",          // "low" | "medium" | "high" | "raw" | null
  "experience_mode": "standard",     // 5.8 only: "standard" | "performance"; null on 5.7
  "cache_bytes": 734003200,          // null when the cache folder cannot be measured
  "web_api_enabled": false,          // constant in Stage 1: Hayba calls no Fab web service
  "contract": { "ok": true, "fab_contract_changed": [] },
  "active_jobs": [ { "job_id": "…", "kind": "import_watch", "status": "waiting_for_user" } ],
  "hint": "Fab signs in when its tab opens. Open Window > Fab, or call hayba_fab_open."
}
```

How the session is decided. No Fab symbol is used and no credential is read.

1. On the game thread, take `IEOSSDKManager::Get()->GetActivePlatforms()`.
2. Keep the platforms whose `GetConfigName()` is empty. Fab's platform is one of them (section 3.2).
3. For each, count the accounts that `EOS_Auth_GetLoggedInAccountByIndex` returns and whose `EOS_Auth_GetLoginStatus` is logged in.
4. Decide:

| Unnamed platforms | Result |
|---|---|
| none | `unknown` |
| every one has at least one signed-in account | `signed_in` |
| none has a signed-in account | `not_signed_in` |
| they disagree | `unknown`. It is never a guess |

`reason_unavailable` values:

| Value | Condition |
|---|---|
| `fab_disabled` | the `Fab` module is not loaded although the satellite is. It is a defensive value: when the Fab plugin is disabled, the editor disables the satellite too, and Node answers `fab_satellite_missing` |
| `emporium` | the `Emporium` plugin is enabled (5.8: Fab skips its own start-up) |
| `commandlet` | the process is a commandlet. Fab does not start there (`F58/Private/FabModule.cpp:51`) |
| `web_browser_unavailable` | the web browser module cannot create a browser |
| `non_production_environment` | Fab's `Environment` setting is not production |

Refusals: none from the handler. It always answers when the satellite is loaded. From the router: `editor_unsafe_restart_required`.

### 6.2 `fab_library_sync`

Params: `{ "batch"?: integer 1..1000, default 1000 }`.

What it does:

1. Preflight, in the order of the refusal list below.
2. Snapshot the current rows in memory (at most 5000), so a failed refresh can still serve the last good list.
3. Allocate a job with `OpName` `fab_library_sync`, and start a log capture for `LogFab`.
4. Run Fab's own console command `Fab.TEDS.MyFolderIntegration <batch>` through `IConsoleManager`. The generic console tool is not used. Fab makes its own request with its own credential.
5. Return at once. The pump drives the sync machine (section 9).

```jsonc
{ "job_id": "…", "kind": "library_sync", "status": "running", "batch": 1000,
  "poll": { "command": "fab_job_status", "after_s": 1 } }
```

Refusals from the handler: `bad_request`, `fab_unavailable`, `fab_contract_changed` (missing `library_sync_command`, `library_columns` or `data_storage`), `not_signed_in` (D-F9), `job_already_running` (with `active_job_id`).
Refusals from the router: `editor_unsafe_restart_required`, `pie_active`, `lease_conflict`, `owner_required`.

### 6.3 `fab_library_read`

Params: `{ "name_filter"?: string, "type_filter"?: string, "limit"?: integer 0..200 default 50, "offset"?: integer ≥ 0 default 0 }`.

- `name_filter` is a case-insensitive substring of the title.
- `type_filter` matches `kind` or `listing_type`, case-insensitive, whole value.
- `limit: 0` returns no items and is the cheap way to read `sync_state`.

```jsonc
{
  "items": [
    {
      "id": "0a1b2c3d-…",                 // the row's AssetId as a lower-case GUID
      "namespace": "…",
      "title": "…",
      "listing_type": "…",                 // Fab's value, unchanged
      "source": "…",                       // Fab's value, unchanged
      "seller": "…",
      "distribution_method": "…",
      "kind": "unknown",                   // derived; "unknown" until probe P10 fixes the mapping
      "url": "…",
      "thumbnail": { "url": "…", "width": 0, "height": 0, "type": "…" },   // or null
      "size_bytes": null,                  // Fab stores no size
      "size_known": false,
      "in_project": { "present": null, "paths": [], "join": "unverified" }    // true or false, and "by_recorded_id", once probes P3, P4 and P10 prove the join
    }
  ],
  "total": 0, "offset": 0, "limit": 50, "has_more": false,
  "sync_state": "succeeded",               // "never" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled"
  "synced_at": "2026-09-28T10:00:00Z",     // null when never
  "stale": false,                          // true when items come from the last good snapshot
  "sync_error": null,                      // { "code": "fab_library_sync_failed", "reason": "…" } after a failed sync
  "warnings": []
}
```

Rules:

- Rows are read through `ICoreProvider`. The two Fab columns are found by reflection path; the URL and web-image columns are public types.
- A row whose `AssetId` parses to a zero GUID is skipped and counted in the warning `rows_skipped_zero_id`.
- A missing field is `null`. It is never an empty string presented as a value.
- There is no engine-version compatibility field. Fab's parser drops that data (`F58/Private/Teds/FabMyFolderIntegration.cpp:228-240`).
- `in_project` joins the row id against Fab's recorded ids, read from the saved config file (section 11.5). Until the join is proven, `present` is `null` and `join` is `"unverified"`.
- When the last sync did not succeed, `sync_state` says so, and `items` comes from the last good snapshot with `stale: true`, or is empty when there is none. **An empty `items` with `sync_state: "failed"` is a failure, not an empty library.**

Refusals from the handler: `bad_request`, `fab_unavailable`, `fab_contract_changed`.
Refusals from the router: `editor_unsafe_restart_required`.

### 6.4 `fab_open`

Params: `{ "listing"?: string, "query"?: string (1..200 characters), "free_only"?: boolean }`. At most one of `listing` and `query`. With neither, Fab's home is shown.

**Listing parsing (pure, `HaybaFabListing.h`).** `listing` is an id or a URL.

- An id matches `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` after lower-casing.
- A URL must be `https`, its host must be exactly `fab.com` or `www.fab.com`, and its path must be `/listings/<id>` or `/plugins/ue5/listings/<id>`. A query string or fragment is dropped.
- Anything else is refused with `invalid_listing`. The caller's text is never loaded.

**URL building.** Hayba builds the URL itself, in the form Fab's own "View in Fab" uses.

| | 5.7 | 5.8 |
|---|---|---|
| Base | `https://www.fab.com` | `https://fab.com` |
| Listing | `<base>/plugins/ue5/listings/<id>` | same |
| Search | `<base>/plugins/ue5/search?q=<url-encoded query>` plus `&is_free=1` when `free_only` | same |
| Home | `<base>/plugins/ue5` | same |

**Opening.**

1. Find a live Fab tab and its `SWebBrowser`.
   - 5.7: `FGlobalTabmanager::FindExistingLiveTab("FabTab")`.
   - 5.8: look for `Fab1` … `Fab64` in the global tab manager, then walk the visible windows for an `SWebBrowser` whose current URL starts with a Fab base or with the Fab plugin's local index page. The walk also finds tabs that the global lookup cannot (section 14).
2. If there is none, open one.
   - 5.7: `TryInvokeTab("FabTab")`. Before that, check that the web browser module can create a browser, and wrap the call in `TGuardValue<bool>(GIsRunningUnattendedScript, true)`: without a browser, 5.7 raises a modal (`F57/Private/FabBrowser.cpp:284-289`).
   - 5.8: run the tool-menu entry `OpenFabTab`. It creates a **new** tab on every run (`F58/Private/FabBrowser.cpp:134-144`, `:335-382`), so Hayba runs it only when no live Fab tab exists.
3. If the browser widget exists now, call `LoadURL` and report `navigation: "loaded"`.
4. If the tab exists but its browser is not attached yet, register a one-shot ticker that retries for 20 s, and report `navigation: "pending"`. On 5.8 a natively rendered tab attaches its browser one frame later (`F58/Private/FabBrowser.cpp:423-454`).
5. If no tab can be opened, launch the same URL in the system browser and report `via: "system_browser"`.

```jsonc
{
  "opened": true,
  "via": "fab_tab",                  // "fab_tab" | "system_browser"
  "tab": "existing",                 // "existing" | "created" | null
  "navigation": "loaded",            // "loaded" | "pending" | "not_attempted"
  "url": "https://fab.com/plugins/ue5/listings/0a1b2c3d-…",
  "results": null,                   // always null: this command returns no search data
  "warnings": []
}
```

Refusals from the handler: `bad_request` (both `listing` and `query`), `invalid_listing`, `fab_unavailable`.
Refusals from the router: `editor_unsafe_restart_required`, `pie_active`, `lease_conflict`, `owner_required`.

### 6.5 `fab_import_watch_start`

Params: `{ "listing": string, "timeout_s"?: integer 60..3600 default 900, "size_warn_bytes"?: integer ≥ 1048576 default 2147483648 }`.

These params are refused by name, so an agent with a stale memory of the dead tools gets a clear answer:

| Param | Code |
|---|---|
| `target_path`, `target_dir` | `target_path_unsupported`. Fab decides where content lands (section 3.2) |
| `accept_licence`, `accept_license`, `accept_eula` | `licence_acceptance_unsupported`. Only the person accepts a licence |
| `download_url`, `asset_id`, any other unknown key | `bad_request` |

Preflight, in order. A refusal stops; a warning continues.

| # | Check | Result |
|---|---|---|
| 1 | params | `bad_request`, `target_path_unsupported`, `licence_acceptance_unsupported`, `invalid_listing` |
| 2 | Fab is available | `fab_unavailable` with `reason` |
| 3 | PIE, asked from the backend. This repeats the router's gate as defence in depth | `pie_active` |
| 4 | another import watch is running | `job_already_running` with `active_job_id` |
| 5 | contract items | warning `fab_contract_changed` (section 5.5) |
| 6 | session is `not_signed_in` | warning `not_signed_in` (D-F8) |
| 7 | read-only files under `Content/Fab`, at most 2000 files examined | warning `read_only_files` with up to 20 paths and the source-control provider's name |
| 8 | quality tier is `raw` | warning `quality_tier_raw` |
| 9 | 5.8 and `Content/Fab/Materials` does not exist | warning `megascans_parent_materials_will_be_saved` |
| 10 | acquire the job lease on `asset:/Game/Fab` | `lease_conflict` with the holder's owner. Under Off or Advisory enforcement the job runs and adds the warning `lease_not_held` |

Then the handler snapshots the state it compares against (cache bytes, the recorded ids, the top-level `/Game` folders), allocates the job, starts the captures, opens the listing as `fab_open` does, and returns.

```jsonc
{
  "job_id": "…",
  "kind": "import_watch",
  "status": "waiting_for_user",      // or "opening" when navigation is pending
  "listing_id": "0a1b2c3d-…",
  "listing_url": "https://fab.com/plugins/ue5/listings/0a1b2c3d-…",
  "opened": { "via": "fab_tab", "tab": "existing", "navigation": "loaded" },
  "user_action": "In the Fab tab: sign in if the page asks, read the licence, then click Add to Project. Keep the Fab tab open until the import finishes.",
  "timeout_s": 900,
  "size_warn_bytes": 2147483648,
  "preflight": {
    "quality_tier": "medium",
    "read_only_count": 0,
    "read_only_files": [],
    "source_control": "None",
    "parent_materials": "will_be_copied_and_saved"   // "present" | "will_be_copied_and_saved" | "not_applicable"
  },
  "warnings": [ { "code": "megascans_parent_materials_will_be_saved", "message": "…" } ],
  "poll": { "command": "fab_job_status", "after_s": 2 }
}
```

When the listing had to go to the system browser, `user_action` reads: "Open Window > Fab in the editor, find this listing, read the licence, then click Add to Project. The listing was also opened in your browser."

What the job cannot do, stated in the tool description:

- **Progress** is a state plus the bytes seen on disk. The total is unknown.
- **The size warning** is an observation after the click, not a gate before it.
- **Cancel** stops Hayba watching. Fab's download continues.
- **The landing path** is Fab's choice.

Refusals from the router: `editor_unsafe_restart_required`, `pie_active`, `lease_conflict`, `owner_required`.

### 6.6 `fab_job_status`

Params: `{ "job_id": string }`.

For `kind: "import_watch"`:

```jsonc
{
  "job_id": "…",
  "kind": "import_watch",
  "status": "succeeded",             // "opening" | "waiting_for_user" | "downloading" | "importing"
                                     // | "succeeded" | "failed" | "cancelled" | "timed_out" | "abandoned"
  "terminal": true,
  "phase": "done",                   // "opening" | "waiting_for_click" | "download_observed" | "registry_changes"
                                     // | "settling" | "finalizing" | "done"
  "listing_id": "0a1b2c3d-…",
  "listing_url": "https://fab.com/plugins/ue5/listings/0a1b2c3d-…",
  "started_at": "2026-09-28T10:00:00Z",
  "finished_at": "2026-09-28T10:01:24Z",          // null while running
  "elapsed_s": 84.2,
  "timeout_s": 900,
  "observed": {
    "cache_bytes": 734003200,        // growth of Fab's cache folder since the job started; includes unpacked archives
    "cache_measured": true,
    "new_assets": 12,
    "log_events": ["add_to_project", "listing_type"],
    "unrecognised_log_lines": 3
  },
  "size_warning": null,              // or { "threshold_bytes": 2147483648, "observed_bytes": 2147999999, "at_s": 61.0 }
  "attribution": "fab_recorded",     // "fab_recorded" | "metahuman_rule" | "unconfirmed" | null while running
  "listing_match": "unknown",        // "true" | "false" | "unknown"
  "fab_listing_id": "…",             // the id Fab recorded, or null
  "fab_location": "/Game/Fab/Megascans/3D/Rock_abc",       // the folder Fab recorded, or null
  "imported_roots": ["/Game/Fab/Megascans/3D/Rock_abc", "/Game/Fab/Materials"],
  "imported_paths": ["/Game/Fab/Megascans/3D/Rock_abc/High/SM_Rock"],     // package names, sorted, no duplicates
  "imported_assets": [
    { "path": "/Game/Fab/Megascans/3D/Rock_abc/High/SM_Rock.SM_Rock",
      "package": "/Game/Fab/Megascans/3D/Rock_abc/High/SM_Rock",
      "class": "StaticMesh", "change": "added" }           // "added" | "updated"
  ],
  "unsaved_packages": ["/Game/Fab/Megascans/3D/Rock_abc/High/SM_Rock"],
  "saved_by_fab": ["/Game/Fab/Materials/Standard/M_MS_Base"],
  "evaluated_at": "2026-09-28T10:01:24Z",
  "truncated": false,
  "pie_started_during_job": false,
  "cancel_requested": false,
  "lease": { "held": false, "resource": "asset:/Game/Fab" },
  "warnings": [],
  "error": null,                     // or { "code": "fab_download_failed", "message": "…" }
  "next": "Save only the packages you choose from unsaved_packages. Hayba saved nothing."
}
```

Definitions:

| Key | Meaning |
|---|---|
| `imported_paths` | Package names of every asset that was added or updated under the watch roots during the job. **Core contract** |
| `unsaved_packages` | The subset of `imported_paths` whose package is dirty, or has no file on disk, at `evaluated_at`. **Core contract** |
| `saved_by_fab` | The subset that already has a file on disk and is not dirty. `imported_paths` is the disjoint union of `unsaved_packages` and `saved_by_fab` |
| `imported_roots` | The smallest set of folders that contains every imported path. It is meant to be used as a pathspec |
| `evaluated_at` | When the two subsets were computed. The result is a snapshot: a later save does not change it |
| `attribution` | Why the job believes the changes belong to a Fab import (section 8.4) |
| `listing_match` | Whether the id Fab recorded equals the requested listing. `unknown` until probes P3 and P4 prove the join |

The two core keys and `saved_by_fab` are present and are arrays in every reply, from the first poll on. They are empty until the job knows better.

For `kind: "library_sync"`:

```jsonc
{
  "job_id": "…", "kind": "library_sync",
  "status": "succeeded",             // "running" | "succeeded" | "failed" | "cancelled" | "timed_out"
  "terminal": true,
  "started_at": "…", "finished_at": "…", "elapsed_s": 4.1,
  "observed": { "rows": 405, "pages_parsed": 1, "log_events": ["response_received", "page_parsed"], "unrecognised_log_lines": 0 },
  "cancel_requested": false,
  "warnings": [],
  "error": null                      // or { "code": "fab_library_sync_failed", "reason": "request_failed_or_not_json" }
}
```

Refusals from the handler: `bad_request`, `job_unknown` (unknown id, or an id that is not a Fab job). After an editor restart every earlier id is unknown, because the registry lives in memory.

### 6.7 `fab_job_cancel`

Params: `{ "job_id": string }`.

```jsonc
{
  "job_id": "…",
  "cancelled": true,
  "effect": "stopped_watching",
  "fab_download": "not_cancelled",
  "note": "Hayba stopped watching. Fab's own download or import continues; cancel it from Fab's notification."
}
```

- The command sets the registry's cancel flag. The pump sees it on its next tick, releases the lease and finishes the job as `cancelled`.
- Cancelling a job that is already terminal is not an error: `{ "cancelled": false, "status": "<terminal status>", "note": "The job had already finished." }`.
- Fab's request queue is private, so Hayba cannot cancel the download (section 3.2).

Refusals from the handler: `bad_request`, `job_unknown`.

---

## 7. MCP tools

### 7.0 Common rules

- Six hand-written descriptors in `STANDARD_DESCRIPTORS`, in one block in `N/src/tools/index.ts`.
- Every schema is strict. An unknown key is refused with `bad_request` before anything reaches the socket, except the named keys of section 6.5, which keep their own codes.
- A tool result is one JSON object. A refusal is `{ "ok": false, "code", "error", "hint", …detail }` with `isError: true`.
- **Missing satellite.** A reply of `Unknown command` for a `fab_*` wire command becomes `{ "ok": false, "code": "fab_satellite_missing", "hint": "The HaybaMCPFab plugin is not installed in this project, or the engine's Fab plugin is disabled." }`.
- **Polling.** `wait_s` polls `fab_job_status` once a second. A poll that times out or meets `ECONNREFUSED` is counted as `editor_busy` and polling continues within `wait_s`: while Fab's import holds the game thread, the editor stops accepting connections (`N/src/tools/heavy-ops.ts:4-12`). If no poll answered, the tool returns `{ "editor_busy": true, "last_known": {…} }`.
- **No retry for start commands.** `fab_import_watch_start` and `fab_library_sync` are in `NON_IDEMPOTENT` (`N/src/tools/tool-executor.ts:46-175`). After a transport failure the tool returns the `transport` error and the hint "call hayba_fab_login_status and read active_jobs to find the job".
- **Redaction.** Every result passes the general boundary redaction. The Fab tools also scrub their own results first (section 11.6).

### 7.1 `hayba_fab_login_status`

Input: `{}`. Wire: `fab_status`. Output: the `fab_status` shape, unchanged.

### 7.2 `hayba_fab_library_list`

Input: `{ "refresh"?: boolean default false, "wait_s"?: integer 0..120 default 30, "name_filter"?, "type_filter"?, "limit"?, "offset"? }`.

1. `fab_library_read` with `limit: 0`, to learn `sync_state`.
2. If `refresh` is set, or `sync_state` is `never`: `fab_library_sync`, then poll within `wait_s`. A `job_already_running` refusal attaches to the running job.
3. `fab_library_read` with the caller's filters.

Output: the `fab_library_read` shape plus `job_id` and `waited_s`.

| Situation | Output |
|---|---|
| The sync succeeded | `ok: true`, the items |
| `wait_s` ran out while the sync was still running | `ok: true`, `partial: true`, `sync_state: "running"`, `job_id`, and the last good items with `stale: true` |
| The sync failed | `ok: false`, `code: "fab_library_sync_failed"`, `sync_error.reason`, `sync_state: "failed"`, the last good items with `stale: true` or none, and the hint in section 17 (R1) |
| Not signed in | `ok: false`, `code: "not_signed_in"`, and the hint "open the Fab tab so Fab can sign in" |

### 7.3 `hayba_fab_add_to_project`

Input: `{ "listing": string, "wait_s"?: integer 0..120 default 0, "timeout_s"?: integer 60..3600 default 900, "size_warn_bytes"?: integer default 2147483648 }`.

Wire: `fab_import_watch_start`, then optional polling. Output: the start reply when `wait_s` is 0, otherwise the latest `fab_job_status` reply plus `waited_s`, `user_action` and `preflight`.

The description says, in these words: "Hayba opens the listing in Fab's own tab. You read the licence and click Add to Project. Hayba watches and reports; it downloads nothing, accepts nothing and saves nothing."

### 7.4 `hayba_fab_job_status`

Input: `{ "job_id": string, "wait_s"?: integer 0..120 default 0 }`. With `wait_s`, the tool returns as soon as `status` changes or becomes terminal. Output: the `fab_job_status` shape plus `waited_s`.

### 7.5 `hayba_fab_job_cancel`

Input: `{ "job_id": string }`. Output: the `fab_job_cancel` shape.

### 7.6 `hayba_fab_open`

Input: `{ "listing"?: string, "query"?: string, "free_only"?: boolean }`. Output: the `fab_open` shape. The description says that the tool shows results to the person and returns none.

### 7.7 Tools that are not registered

`hayba_fab_marketplace_search` and `hayba_fab_download` are not registered in Stage 1. A registry test asserts that (section 12.3). A tool that can answer nothing is not shipped.

### 7.8 The five layers, applied

| Layer | For the Fab commands |
|---|---|
| 1. Declare | Seven names in `FHaybaMCPFabHandler::GetCommands()` and seven branches in `Handle()` |
| 2. Sidecar descriptor | Seven entries in `sidecar.json`, appended as one block, with `handler_cpp: "FHaybaMCPFabHandler::Handle"` and notes that say the satellite is optional |
| 3. `returns` | Every entry lists the top-level keys of its reply, as in section 6 |
| 4. Flags | `has_ts_wrapper: true`, because the wrappers call `executeCommand('<name>')` with a literal. `agent_callable: false`, so the commands are documented by `get_tool_signature` but reached only through the six tools, which enforce the strict schemas. This pair of values is new: of the 160 sidecar entries today, 112 are callable without a wrapper, 44 are callable with one, and 4 are neither (V15) |
| 5. `list-tool-categories` | The six tools appear in the domain `fab` by themselves: the callable half is derived from the registry, and `domainOf('hayba_fab_open')` is `fab`. **No `DOMAINS` rows are added**: that array lists plugin commands no wrapper reaches, and listing wrapped wire names there would report them as unavailable. `inferDir()` gets its `hayba_fab_` rule back |

Static checks that must learn the satellite in the same commit (ADR-0007):

- `no-stub-wrappers.test.ts`: add the `HaybaMCPFab` private folder to `SATELLITE_HANDLER_DIRS`.
- `wire-command-names.test.ts`: scan the satellite source folders as well as the core's, so a Fab command is proven by its C++ and not only by its sidecar entry.
- `packs.yaml`: add the six tools to the connectors pack.

---

## 8. The watch state machine

`HaybaFab::FWatchMachine` lives in `HaybaFabWatchPolicy.h`. It is pure: no `GEditor`, no file access, no Slate, no clock of its own. The driver passes the time and the facts on every tick and performs the one action the machine returns. It has the same form as the batch machine (`P/Private/HaybaMCPBatchPolicy.h:228-247` `@leases`).

### 8.1 States

| State | Meaning | Terminal |
|---|---|---|
| `opening` | The listing was requested; the Fab tab's browser is not attached yet | no |
| `waiting_for_user` | The listing is shown, or the person was told where to find it. Nothing proves a click yet | no |
| `downloading` | Fab's cache grows, or Fab logged that the listing was added | no |
| `importing` | The asset registry reports changes under the watch roots | no |
| `succeeded` | The import settled (section 8.4) | yes |
| `failed` | Fab reported a failure, or the editor became unsafe | yes |
| `cancelled` | The caller cancelled the watch | yes |
| `timed_out` | `timeout_s` passed without a terminal state | yes |
| `abandoned` | The Fab tab was closed before anything proved a click | yes |

### 8.2 Inputs, per tick

```cpp
struct FInputs
{
    double Now = 0.0;                  // injected clock, seconds
    int64  CacheGrowthBytes = 0;       // max(0, current - baseline); -1 when it cannot be measured
    int32  NewChanges = 0;             // registry adds and updates under the watch roots, drained this tick
    bool   bAllChangesUnderMetaHuman = false;   // over the whole job, not only this tick
    bool   bRecordCoversChanges = false;        // a new Fab local-assets entry is an ancestor folder of a changed path
    ETriState RecordMatchesListing = ETriState::Unknown;
    bool   bListingShown = false;
    bool   bFabTabOpen = false;
    bool   bPieActive = false;
    bool   bCancelRequested = false;
    bool   bEditorUnsafe = false;
    uint32 Events = 0;                 // bit set of EFabLogEvent seen this tick (section 11.7)
};
```

The machine holds no paths. The driver collects them, bounded at 512.

### 8.3 Timers

All are fields of `FTuning`, so tests can shrink them.

| Timer | Default | Use |
|---|---|---|
| `TimeoutSeconds` | 900 (from `timeout_s`, 60 to 3600) | absolute deadline from the start |
| `OpenTimeoutSeconds` | 20 | how long `opening` waits for the browser |
| `TabCloseGraceSeconds` | 2 | a tab must stay closed this long to count as closed; docking a tab closes and reopens it |
| `MinGrowthBytes` | 65536 | cache growth that counts as evidence of a download |
| `QuietSeconds` | 3 | no registry change for this long means the import settled |
| `MetaHumanQuietSeconds` | 10 | the same, for the MetaHuman rule |
| `RecordGraceSeconds` | 15 | how long a settled import waits for Fab's record before it ends as `unconfirmed` |
| `StallWarnSeconds` | 120 | no evidence of any kind while `downloading` |

Driver cadences, outside the machine: cache and config reads once a second; registry, log, tab and PIE reads every tick; progress published at most four times a second.

### 8.4 Transitions

Each tick evaluates in this order. The first terminal result wins.

**1. Global stops, from any non-terminal state.**

| Condition | To | Error code |
|---|---|---|
| `bEditorUnsafe` | `failed` | `editor_unsafe_restart_required` |
| `bCancelRequested` | `cancelled` | none |
| event `download_failed` | `failed` | `fab_download_failed` |
| event `import_failed` | `failed` | `fab_import_failed` |
| event `import_rejected` | `failed` | `fab_import_rejected` |

**2. Latches.** They change no state.

| Condition | Effect |
|---|---|
| `bPieActive`, first time | `pie_started_during_job = true` and the warning `pie_started_during_job`. **The job does not stop, pause or refuse anything: PIE starting mid-job is flagged, not acted on** |
| `CacheGrowthBytes >= size_warn_bytes`, first time | `size_warning` is set with the bytes and the time. **It fires once. It is never cleared and never repeated** |
| `bFabTabOpen`, first time | remember that a tab was seen |
| event `already_processing` | the warning `fab_already_processing`: Fab ignored the click because it is already working on this listing |
| `CacheGrowthBytes == -1` | `cache_measured = false`, once |

**3. State transitions.**

| From | Condition | To |
|---|---|---|
| `opening` | `bListingShown` | `waiting_for_user` |
| `opening` | `Now - StartedAt >= OpenTimeoutSeconds` | `waiting_for_user`, with the action `FallBackToSystemBrowser` and the warning `listing_not_shown_in_editor` |
| `opening`, `waiting_for_user` | `NewChanges > 0` | `importing`. This is the path of a cached asset: Fab reuses the cached file and downloads nothing |
| `opening`, `waiting_for_user` | event `add_to_project`, or `CacheGrowthBytes >= MinGrowthBytes` | `downloading` |
| `opening`, `waiting_for_user` | a tab was seen, and `bFabTabOpen` has been false for `TabCloseGraceSeconds` | `abandoned` |
| `downloading` | `NewChanges > 0` | `importing` |
| `downloading` | no growth, no change and no event for `StallWarnSeconds` | stays; the warning `download_stalled`, once |
| `downloading`, `importing` | a tab was seen, and `bFabTabOpen` has been false for `TabCloseGraceSeconds` | stays; the warning `fab_tab_closed_during_import`, once |
| `importing` | `NewChanges > 0` | stays; the quiet timer restarts |
| `importing` | quiet for `QuietSeconds` and `bRecordCoversChanges` | `succeeded`, `attribution: "fab_recorded"` |
| `importing` | quiet for `MetaHumanQuietSeconds` and `bAllChangesUnderMetaHuman` | `succeeded`, `attribution: "metahuman_rule"` |
| `importing` | quiet for `RecordGraceSeconds` | `succeeded`, `attribution: "unconfirmed"`, the warning `unattributed_import` |

**4. Timeout.** If the state is still not terminal and `Now - StartedAt >= TimeoutSeconds`: `timed_out`. The success check of step 3 runs before this one, so an import that settles on the deadline tick succeeds.

### 8.5 The named cases

| Case | Behaviour |
|---|---|
| **MetaHuman without a record** | The MetaHuman workflow never records an entry. The job succeeds through the MetaHuman rule when every change is under `/Game/Fab/MetaHuman` and the registry has been quiet for 10 s |
| **Abandoned on tab close** | Only while `opening` or `waiting_for_user`, only if a Fab tab was seen during the job, and only after the grace. If the listing went to the system browser and no Fab tab was ever open, the job cannot be abandoned; it can time out |
| **Tab closed later** | A warning, not a stop. Fab's workflows keep running for a while after the tab closes, and whether that is safe is probe P7 |
| **`timed_out`** | Also the outcome of two Fab behaviours that leave no trace Hayba can read. A failed pack download logs nothing (`F58/Private/Workflows/PackImportWorkflow.cpp:284-291`). Fab's own hang on an unknown Megascans sub-type ends here when its log line was not seen; the reply then adds the note that Fab will refuse the same listing until its tab is reopened |
| **The one-shot 2 GiB warning** | Observed bytes include unpacked archives, so they are an upper bound on the download. The warning says so |
| **PIE starting mid-job** | Flagged in `pie_started_during_job`. The job lease makes this rare: an agent's `editor_start_pie` answers `asset_busy`, and the user's Play button is vetoed by P0 T10 with a double-press override |
| **A different listing** | If Fab's record names another id, the job still succeeds, with `listing_match: "false"` and the warning `different_listing_imported` |
| **Editor unsafe** | The pump finishes the job as failed without calling the backend again (section 10.3) |

### 8.6 What the driver does at the end

On any terminal state the driver:

1. computes `imported_paths`, `unsaved_packages`, `saved_by_fab` and `imported_roots`, in slices of 256 packages per tick;
2. releases the job lease;
3. stops the log capture and the registry subscription;
4. calls `SetDone` with exit code 0 for `succeeded` and 1 for every other terminal state;
5. removes its ticker.

Watch roots: `/Game/Fab`, and every top-level `/Game` folder that did not exist when the job started. Packs land in such a folder.

---

## 9. The library sync machine

`HaybaFab::FSyncMachine`, in the same header, with the same injected clock.

| Input | Meaning |
|---|---|
| `Now` | injected clock |
| `RowCount` | rows in the `Fab` table |
| `Events` | `response_received`, `page_parsed`, `sync_not_signed_in`, `sync_request_failed`, `sync_invalid_json`, `sync_missing_results`, `sync_storage_unavailable` |
| `bCancelRequested`, `bEditorUnsafe` | as in section 8 |

| Condition | Result |
|---|---|
| `bEditorUnsafe` | `failed`, `editor_unsafe_restart_required` |
| `bCancelRequested` | `cancelled` |
| `sync_not_signed_in` | `failed`, code `not_signed_in` |
| `sync_request_failed` | `failed`, code `fab_library_sync_failed`, reason `request_failed_or_not_json` |
| `sync_invalid_json` | `failed`, reason `invalid_json` |
| `sync_missing_results` | `failed`, reason `missing_results` |
| `sync_storage_unavailable` | `failed`, reason `storage_unavailable` |
| at least one `page_parsed`, then no event and no row-count change for 3 s | `succeeded` |
| no event of any kind for 30 s | `failed`, code `fab_library_sync_no_response` |
| 120 s since the start | `timed_out` |

The machine needs these log lines because Fab offers no completion callback. If a future Fab changes the wording, no event is recognised, the job ends as `fab_library_sync_no_response`, and `unrecognised_log_lines` shows that something was logged. It fails closed.

---

## 10. Job registry extension

### 10.1 What changes

`FHaybaJobState` gains five fields. `EHaybaJobStatus` keeps its two values.

```cpp
struct FHaybaJobState
{
    // existing fields unchanged
    FString   Owner;                   // effective owner that started the job
    FString   Progress;                // condensed JSON, replaced whole; empty means none
    FDateTime ProgressAt;
    bool      bCancelRequested = false;
    FDateTime CancelRequestedAt;
};

class HAYBAMCPTOOLKIT_API FHaybaMCPJobRegistry
{
public:
    // existing functions unchanged
    /** Replace a Running job's progress record. No-op for a Done or unknown job. At most 16 KiB. */
    void SetProgress(const FString& JobId, const FString& ProgressJson);
    /** Ask a Running job to stop. True when the job exists and is Running. Calling it again changes nothing. */
    bool RequestCancel(const FString& JobId);
    bool IsCancelRequested(const FString& JobId) const;
    void SetOwner(const FString& JobId, const FString& Owner);
};
```

### 10.2 Rules

- **Progress JSON** is the job's own status record. For a Fab job it is the `fab_job_status` reply without the final result arrays. The registry treats it as text.
- **Statuses stay job-specific.** `waiting_for_user` and the rest live in the progress record's `status`. The terminal status lives in the output's `status`. `ExitCode` is 0 for `succeeded` and 1 otherwise, so `build_status` keeps meaning `ok = exit_code == 0`.
- **The cancel flag is generic.** It is a request, not an action: the job's own pump decides what stopping means. A later `batch_cancel` can use the same flag; this spec does not build it.
- **Bounds.** Progress is at most 16 KiB and output at most 256 KiB. A Fab job's arrays are cut to fit and marked `truncated`.
- **`build_status`** adds `progress` (the parsed object) when a job has one, and `cancel_requested`. Its existing keys do not change.
- **Everything is scrubbed before it is stored** (section 11.6). `build_status` can read a Fab job's output, so the registry must never hold an unscrubbed string.
- **Not changed here:** jobs are still never removed from the registry.

### 10.3 The pump preamble

Both Fab pumps are `FTSTicker` core-ticker delegates. They never use `AsyncTask(GameThread)` and never wait. Each tick runs in this order, which mirrors the batch pump preamble of the P0 spec (section 3.0 there):

1. If the job is finished, remove the ticker and return.
2. **Unsafe stop.** If `IsEditorUnsafe()`: finish the job as failed with `editor_unsafe_restart_required`, release the lease (a pure table operation), stop the captures, and return. The backend is not called again.
3. **Lease keep-alive.** Renew the job lease at a third of its 90 s lifetime.
4. **Gather** the inputs from the backend, at the cadences of section 8.3. The backend calls run inside the seam's `RunGuarded`.
5. **Tick** the machine and perform its one action.
6. **Publish** progress, or finalize.

The pump measures its own game-thread time. A tick over 5 ms adds the warning `pump_budget_exceeded` once. The cache measurement is the expensive part: it walks at most 20,000 directory entries per measurement and gives up with `cache_measured: false` beyond that.

When the satellite module shuts down, every running Fab job is finished as failed with `fab_satellite_unloaded`, and its lease is released.

---

## 11. Safety rules

### 11.1 The three things the tools must never do

1. **Read an auth token.**
2. **Run `EOSSDK INFO`.**
3. **Accept a licence.**

### 11.2 What follows from them

| Never | Because |
|---|---|
| call `EOS_Auth_CopyUserAuthToken`, `EOS_Auth_CopyIdToken`, or any `LogInfo` / `LogAuthInfo` function of the EOS manager or a platform handle | they return or log the credential (`E58/Private/EOSSDKManager.cpp:1340-1370`) |
| call `GetAuthToken` or `GetRefreshToken` on `UFabBrowserApi`, by reflection or otherwise | they return the credential (`F58/Private/FabBrowserApi.cpp:513-528`) |
| read the `CustomAuthToken` property of Fab's settings, or load the asset `/Fab/Data/FabEos` | both hold credentials |
| read `AUTH_PASSWORD` or `AUTH_TYPE` from the command line | Fab's fallback sign-in reads an exchange code there (`F58/Private/FabAuthentication.cpp:258-266`) |
| call `AddToProject`, `InstallToProject`, `InstallToEngine`, or any function of Fab's bridge | that would impersonate the page, and it is where a licence is accepted |
| run JavaScript in Fab's tab | the page contract is Epic's, and the page can reach the credential getters |
| run `Fab.Login`, `Fab.Logout`, `Fab.SetEnvironment` or `Fab.ClearCache` | they change the user's session, environment or cache |
| load a URL in Fab's tab that Hayba did not build (D-F11) | the bridge is bound to that browser |
| use the library sync as a status probe | it makes an authenticated network call |

A Node source-scan test asserts that none of these strings appears in the satellite: `CopyUserAuthToken`, `CopyIdToken`, `LogAuthInfo`, `GetAuthToken`, `GetRefreshToken`, `CustomAuthToken`, `FabEos`, `AUTH_PASSWORD`, `AddToProject`, `InstallToProject`, `InstallToEngine`, `ExecuteJavascript`, `EOSSDK INFO`, `Fab.Login`, `Fab.Logout`, `Fab.SetEnvironment`, `Fab.ClearCache`. It also asserts that the satellite names exactly one console command, `Fab.TEDS.MyFolderIntegration`, and passes no caller text to the console. The scan strips comments first and asserts a minimum number of scanned files, so it fails closed.

### 11.3 PIE

- **At start:** the router refuses with `pie_active` (P0 T2). The handler repeats the check through the backend.
- **During a job:** flagged in `pie_started_during_job`, never acted on. The job neither stops PIE nor pauses.
- **While a job runs:** the job lease makes an agent's `editor_start_pie` answer `asset_busy` (P0 T3, `AnyBusyCommands`), and P0 T10 vetoes the user's Play button with an override.
- The two job commands answer during PIE.

### 11.4 Saving

- Hayba saves nothing in any Fab tool. There is no `save` param.
- `unsaved_packages` lets the caller save exactly what it chooses, by pathspec, with Hayba's save tools. Those tools carry the `package_read_only` preflight (P0 T5).
- What Fab saved by itself is reported in `saved_by_fab`, because Hayba cannot prevent it. On 5.8 that includes the Megascans parent materials. Fab rewrites its Megascans parent settings in the same step; they are a config file, not a package, so the job reports them with the warning `megascans_parent_settings_rewritten`. Packs are written to disk directly.

### 11.5 Read-only files and source control

- The preflight warns when files under `Content/Fab` are read-only. It uses the same check as `HaybaSaveVerify::FindReadOnlyPackageFiles` and names the source-control provider. It never clears a read-only flag.
- It is a warning, not a refusal. Hayba is not the writer, and it does not know the exact target before the click.
- A pack's files are written to disk under the editor, outside source-control checkout. The job reports the paths it saw change; it cannot list a pack's target in advance.
- **Fab's record is read from the saved config file**, not from the live object. Fab mutates and saves that object on a task-graph thread (section 3.2). Hayba reads the file with a bounded read, parses only the section `[/Script/Fab.FabLocalAssets]`, tolerates a half-written file by trying again on the next read, and never parses or returns any other section of that file.

### 11.6 Redaction of token-shaped strings, on both sides

| Side | Rule |
|---|---|
| Editor, satellite | `HaybaFab::Scrub` runs on every string before it enters a response, a progress record, a job output or a log line. It replaces JWTs (`eyJ….….…`), `eg1~…` values and `Bearer …` values with `[REDACTED:token]` |
| Editor, core | The final envelope redaction still runs on every response. It gains the `eg1~` pattern (C5) |
| Node, Fab tools | `scrubFabResult` runs on every Fab tool result with the same three patterns |
| Node, boundary | `redactMcpResult` still runs on every tool result. It gains the `eg1~` pattern (C5) |

- The pattern for the new prefix is `\beg1~[A-Za-z0-9._~+/=-]{16,}`.
- A generic 32-hex pattern is **not** added: it would destroy asset ids.
- The fixed texts of section 6 are passed through both redactors in a test and must come out unchanged.
- URLs from Fab's feed keep their path. The existing URL rule masks secret-looking query values.

### 11.7 Log captures

- A Fab job captures the category `LogFab` only, through an output device that queues lines from any thread and is drained on the game thread.
- **`LogEOSSDK` is dropped from every capture.** A Fab job never subscribes to it, to `LogEOSShared`, or to `LogHttp`. The core's two log readers drop `LogEOSSDK` lines as well (C7).
- Captured lines are never stored or returned as text. `HaybaFabLogEvents.h` maps a known message prefix to an event code and counts the rest (D-F10).

| Event | Message prefix |
|---|---|
| `add_to_project` | `Add listing to project - ` |
| `listing_type` | `Listing type - ` |
| `already_processing` | `The listing with Id ` |
| `download_failed` | `Failed to download ` |
| `import_failed` | `Asset import failed: `, `Failed to import Megascan asset: `, `Import files not found for `, `Failed to unzip ` |
| `import_rejected` | `Invalid Quixel asset type: `, `Asset type not handled ` |
| `response_received` | `Result for (portion of) the My Folder data.` |
| `page_parsed` | `Parsed data for (portion of) My Folder.` |
| `sync_not_signed_in` | `Unable to retrieve My Folder data due to user not being logged into Fab.` |
| `sync_request_failed` | `Unable to retrieve My Folder data due to the request failing` |
| `sync_invalid_json` | `Unable to retrieve My Folder data due to returned result not being valid JSON.` |
| `sync_missing_results` | `Unable to store My Folder data due missing results.` |
| `sync_storage_unavailable` | `Unable to store My Folder data due the ` |

The only value taken from a line is the id after `Add listing to project - `, and only when it matches the id pattern of section 6.4.

### 11.8 Licences, size, leases

- **Licences.** The licence is shown to, read by and accepted by the person, on Fab's page. No param, setting or default changes that.
- **Size.** Before the start: a warning when the quality tier is `raw`. During the job: one warning when the observed bytes pass `size_warn_bytes` (2 GiB by default). Neither is a gate.
- **Leases.** The start command's implied claim and the job's held lease both name `asset:/Game/Fab`. The lease is a marker (D-F7). A response never carries a lease id.

---

## 12. The fake-backend seam and the tests

### 12.1 `IHaybaFabBackend`

Everything that touches the engine, Fab, the file system, Slate or the core's state goes through this interface. The handler, the pumps and the machines see nothing else.

| Method | Returns | Production source |
|---|---|---|
| `GetAvailability()` | available, reason, Fab version, engine version | module manager, plugin manager |
| `ProbeContract()` | the missing contract items | reflection and name lookups (section 5.5) |
| `GetSession()` | state and the three counts | EOS active platforms |
| `QualityTier()` | the tier, or none | reflection on Fab's settings |
| `IsProductionEnvironment()` | bool | reflection on Fab's settings |
| `IsFabTabOpen()` | bool | tab manager, then the widget walk |
| `OpenListing(target)` | via, tab, navigation, URL | tab manager, tool menus, `SWebBrowser`, system browser |
| `TryNavigate(url)` | bool | `SWebBrowser::LoadURL` |
| `StartLibrarySync(batch)` | bool | console manager |
| `LibraryRowCount()` | count | editor data storage |
| `ReadLibraryRows()` | rows | editor data storage and reflection |
| `CacheBytes()` | bytes, or -1 | a bounded walk of Fab's cache folder |
| `DrainRegistryChanges()` | added and updated assets under the watch roots | asset registry delegates |
| `DrainFabLogEvents()` | event codes, the unrecognised count, a validated id | the `LogFab` capture |
| `ReadLocalAssetsRecord()` | folder to id map | the saved config file |
| `SnapshotTopLevelFolders()` | folder names | asset registry |
| `DescribePackages(packages)` | dirty, on disk, class | package and file lookups |
| `FindReadOnlyFiles(max)` | paths, provider name | file manager, source control module |
| `IsPIEActive()` | bool | `GEditor->PlayWorld` or a queued play request |
| `IsEditorUnsafe()` | bool | the satellite seam |
| `AcquireJobLease()`, `RenewJobLease()`, `ReleaseJobLease()` | granted, holder | the satellite seam |

- `FHaybaFabPluginBackend` is the production implementation.
- `FHaybaFabFakeBackend` is scripted per test: sessions, library fixtures (including a zero-GUID row and rows with missing fields), cache-byte timelines, bursts of registry changes, log events, tab closes, PIE toggles, a lapsed lease, an unsafe editor, and notes that contain token-shaped strings.
- The clock is a separate injection: the machines take `Now` as an input, and the pumps take a clock function.

### 12.2 Automation tests (C++)

All run under the filter `Hayba`. The filter `Hayba.MCP` would skip every one of them.

**Pure.**

| Test | Asserts |
|---|---|
| `Hayba.Fab.Listing.ParseAndBuildUrl` | ids and the four URL forms parse; the built URL has the engine's base |
| `Hayba.Fab.Listing.RejectsForeignHosts` | other hosts, other schemes, look-alike hosts and extra path segments are refused |
| `Hayba.Fab.LogEvents.MapKnownLines` | every row of section 11.7 |
| `Hayba.Fab.LogEvents.NeverKeepsText` | a line with a server response or a client id yields only a code or a count |
| `Hayba.Fab.Scrub.TokenShapes` | the three shapes are replaced; an asset GUID is not |
| `Hayba.Fab.Watch.WaitingToDownloading` | by cache growth, and by the log event |
| `Hayba.Fab.Watch.WaitingToImportingWhenCached` | registry changes without growth |
| `Hayba.Fab.Watch.SucceedsOnRecordAndQuiet` | both conditions are needed |
| `Hayba.Fab.Watch.QuietTimerRestartsOnNewChanges` | a late burst delays success |
| `Hayba.Fab.Watch.MetaHumanWithoutRecord` | the MetaHuman rule |
| `Hayba.Fab.Watch.UnconfirmedAfterRecordGrace` | `unconfirmed` plus the warning |
| `Hayba.Fab.Watch.DifferentListingStillSucceeds` | `listing_match: "false"` plus the warning |
| `Hayba.Fab.Watch.AbandonedOnTabClose` | only while waiting, only after the grace, only if a tab was seen |
| `Hayba.Fab.Watch.TabCloseDuringDownloadWarnsOnly` | no stop |
| `Hayba.Fab.Watch.TimedOut` | at the deadline; success on the deadline tick wins |
| `Hayba.Fab.Watch.SizeWarningFiresOnce` | one warning across many ticks above the threshold |
| `Hayba.Fab.Watch.PieStartFlaggedNotActedOn` | the flag is set and the state does not change |
| `Hayba.Fab.Watch.CancelStopsWatching` | `cancelled` from every non-terminal state |
| `Hayba.Fab.Watch.UnsafeStops` | `failed` with the P0 code |
| `Hayba.Fab.Watch.FailureEvents` | the three failure events |
| `Hayba.Fab.Watch.OpeningFallsBackToSystemBrowser` | the action and the warning after 20 s |
| `Hayba.Fab.Sync.SucceedsAfterQuietPages` | one page and several pages |
| `Hayba.Fab.Sync.FailsOnEachErrorEvent` | four reasons |
| `Hayba.Fab.Sync.NotSignedIn` | the code |
| `Hayba.Fab.Sync.NoResponse` | 30 s without an event |

**Handler and pumps, with the fake backend.**

| Test | Asserts |
|---|---|
| `Hayba.Fab.Handler.CommandsRegistered` | exactly the seven names; none of the four dead names |
| `Hayba.Fab.Handler.StatusShapes` | three sessions and five unavailable reasons |
| `Hayba.Fab.Handler.SessionAmbiguousIsUnknown` | two unnamed platforms that disagree |
| `Hayba.Fab.Handler.ContractChangedReported` | in the status, as a refusal, and as a warning |
| `Hayba.Fab.Handler.LibraryReadShapeAndPaging` | filters, paging, the zero-GUID row, missing fields as `null` |
| `Hayba.Fab.Handler.LibraryReadAfterFailedSyncIsNotEmptySuccess` | `sync_state: "failed"`, stale items from the snapshot |
| `Hayba.Fab.Handler.LibrarySyncRefusals` | every handler code of section 6.2, including D-F9 |
| `Hayba.Fab.Handler.OpenRefusalsAndUrl` | every handler code of section 6.4 |
| `Hayba.Fab.Handler.ImportStartRefusals` | every handler code of section 6.5, including the refused param names |
| `Hayba.Fab.Handler.ImportStartNotSignedInIsAWarning` | D-F8 |
| `Hayba.Fab.Handler.ImportStartDefenceInDepthPie` | the backend's PIE answer refuses |
| `Hayba.Fab.Handler.ImportJobGeneric` | a scripted glTF timeline ends with the right three arrays |
| `Hayba.Fab.Handler.ImportJobMegascansWithParentMaterials` | the parent materials are in `saved_by_fab` |
| `Hayba.Fab.Handler.ImportJobPack` | a new top-level folder becomes a watch root |
| `Hayba.Fab.Handler.UnsavedAndSavedByFabPartition` | the two subsets are disjoint and cover `imported_paths` |
| `Hayba.Fab.Handler.CoreKeysAlwaysPresent` | the two core keys are arrays in the first poll |
| `Hayba.Fab.Handler.JobStatusUnknownId` | `job_unknown`, also for a build job's id |
| `Hayba.Fab.Handler.JobCancelIsIdempotent` | a second cancel and a cancel after the end |
| `Hayba.Fab.Handler.ResponsesCarryNoTokenShapes` | the fake emits token-shaped notes; no response, progress or output carries one |
| `Hayba.Fab.Handler.LeaseHeldAndReleased` | held while running, released on each terminal state |
| `Hayba.Fab.Handler.UnsafeStopsWithoutBackendCalls` | the fake records no call after the flag |
| `Hayba.Fab.Handler.PumpBudget` | a slow fake produces the warning once |
| `Hayba.Fab.Contract.ProbeOnThisEngine` | the real probe returns an empty list on the engine under test |

**Core tests, extended or new.**

| Test | Change |
|---|---|
| `Hayba.MCP.Jobs.ProgressAndCancel` (new) | the four new registry functions, bounds, no-ops for Done and unknown jobs |
| `Hayba.MCP.Jobs.BuildStatusShowsProgress` (new) | `build_status` adds `progress` and `cancel_requested` and keeps its old keys |
| `Hayba.MCP.State.PieRule` | the seven Fab names: four Safe, three Refuse |
| `Hayba.MCP.Health.UnsafeGatePolicy` | only the two job commands answer |
| `Hayba.MCP.Lease.ClassificationDrift`, `Hayba.MCP.Lease.ReadClassDrift`, `Hayba.MCP.State.PieSafeDrift`, `Hayba.MCP.Health.AllowlistDrift` | accept a satellite command when its satellite is not loaded |
| `Hayba.MCP.Satellite.HostSeam` (new) | C2: a job lease is acquired, renewed and released; `CallerOwner` is set inside a dispatch and empty outside one; `RunGuarded` records a fault under the test override |
| `Hayba.MCP.Editor.ConsoleRefusesEosSdk` (new) | C6 |
| `Hayba.MCP.Editor.LogReadersDropEosSdk` (new) | C7 |

### 12.3 Node tests

New files, so they do not collide with other lanes.

| File | Asserts |
|---|---|
| `N/src/tools/fab/fab-tools.test.ts` | the six shapes; every refusal code becomes a structured result; strict schemas; the refused param names keep their codes |
| `N/src/tools/fab/fab-poll.test.ts` | `wait_s` polling; `editor_busy` tolerance for a timeout and for `ECONNREFUSED`; a start command is sent once even when the transport fails |
| `N/src/tools/fab/fab-redaction.test.ts` | the fake sender emits a JWT-like note, an `eg1~` value and a `Bearer` value in notes, warnings and URLs, and all are scrubbed; every fixed text passes both redactors unchanged |
| `N/src/tools/fab/fab-registry.test.ts` | six tools are registered; **`hayba_fab_marketplace_search` and `hayba_fab_download` are not**; the wrappers use exactly the seven wire names and none of the four dead ones; none of the four dead names is a sidecar key; the two start commands are in `NON_IDEMPOTENT` |
| `N/src/tools/fab/fab-unknown-command.test.ts` | `Unknown command` becomes `fab_satellite_missing` |
| `N/src/tools/fab/fab-library-list.test.ts` | the four outcomes of section 7.2, including the failed-sync answer |
| `N/src/tools/fab/fab-contract.test.ts` | source scans that fail closed: the forbidden identifiers of section 11.2; every declared `fab_*` command has a sidecar entry with `returns`; every code the handler emits is in `KNOWN_UE_CODES` and in `IsWireRefusalCode`; no key of section 6 ends in a secret word |
| `N/src/security/secret-redaction.test.ts` (extended) | the `eg1~` pattern; asset GUIDs are untouched |

All tests use a fake `executeCommand` sender. Tests that wrap a handler for the tool stream mock the TCP client, so nothing dials a real editor.

### 12.4 Running them

- **Scratch host only.** Builds, automation runs and live probes happen on a throwaway project under `D:/UEScratch`, for example `D:/UEScratch/FabHost58/FabHost58.uproject` and `D:/UEScratch/FabHost57/FabHost57.uproject`. Never in an existing project.
- The scratch host's `Plugins/` holds **copies** of `HaybaMCPToolkit` and `HaybaMCPFab` from this worktree, not links.
- The headless run is the one in the P0 spec (section 6.3 there), with the scratch project and the `Hayba` filter. The interactive editor is closed during it.
- **Exact names.** A build can report success without compiling a newly added file. A manifest, `N/scripts/fab-expected-automation-tests.txt`, lists every test of section 12.2, and the P0 checker `check-automation-report.mjs` fails when a name is missing or not Success.
- Node: `npx tsc --noEmit && npm test && npm run lint:legacy-wrappers`, then `npm run build:server` before any live check.

---

## 13. Live probes

### 13.1 Rules for every probe

- A probe runs on a **scratch host only**: 5.8 first, then 5.7. Never in an existing project.
- **A person performs the sign-in and every click.** No probe signs in, clicks, or accepts a licence.
- No other editor with Hayba loaded runs on the machine during a probe. A second editor takes the next port after 52342 (`P/Private/HaybaMCPModule.cpp:430-442`), and a client would talk to the wrong one.
- The person uses free listings they are content to add, one per import kind.
- The probe tooling is a throwaway command, `fab_probe_dump`, compiled only when `HAYBA_FAB_PROBES` is defined. It is not in the sidecar, has no wrapper, and is deleted before the satellite merges.
- A probe records **counts, names, paths and shapes**. It never records a value that could be a credential. It never runs `EOSSDK INFO`.
- After every probe, the scratch host's log is searched for token-shaped strings. A hit stops the probes.
- Each result is written to `docs/superpowers/specs/2026-09-28-fab-tools-probes.md` with the engine version, the Fab version, and the date.

The probe numbers are this spec's own. They are in the order of section 2.4: two prerequisites, then the import kinds by priority, then the rest.

### 13.2 The probes

| # | Probe | What the person does | What is recorded | Pass condition | What it decides |
|---|---|---|---|---|---|
| P1 | **Session states** | Starts the editor fresh. Opens Window > Fab. Signs in if asked. Closes the tab. Signs out in Fab's page. Repeats once with another plugin enabled that uses EOS | per step: platform count, unnamed platform count, signed-in accounts | After the tab opens with a valid session there is exactly one unnamed platform with one account | Whether `session` can read `signed_in` rather than `unknown`, and the wording of the hint |
| P2 | **Open and navigate** | Nothing, then looks at the tab. On 5.8 repeats with the experience mode set to performance | whether a tab and its browser were found; the URL after load; whether **Add to Project** is visible; the same for a search URL with and without `is_free=1` | The listing shows with **Add to Project** in both modes, and on 5.7 | Whether `fab_open` works in the editor or falls back to the system browser. Whether the id pattern of section 6.4 is right |
| P3 | **glTF/FBX import** (priority 1) | Clicks **Add to Project** on a small free glTF or FBX listing. Then on one whose archive is already cached | a timeline of cache bytes; the order of registry changes; the landing folder; which packages are dirty and which are on disk; Fab's record (folder and id); the log events seen | The job would reach `succeeded` with `fab_recorded`; the landing folder is `/Game/Fab/<Name>`; every package is unsaved | The watch heuristics for generic imports. Whether Fab's recorded id equals the listing id |
| P4 | **Megascans 3D import, with parent materials** (priority 1) | In a **fresh** scratch project, adds a Megascans 3D asset. Then adds a second one | as P3, plus the packages under `/Game/Fab/Materials`, whether they are on disk and clean, and whether the Megascans parent settings changed | On 5.8 the first import creates and saves the parent materials, and the second does not. On 5.7 neither does | `saved_by_fab`, the `megascans_parent_materials_will_be_saved` warning, and SC2 |
| P5 | **Megascans surface import** (priority 2) | Adds a Megascans surface | as P3 | The landing folder follows the `Surfaces` form; the record is the parent of the tier folder | Whether surfaces need any rule of their own |
| P6 | **UE pack import** (priority 3, low) | Adds a small free pack. Then adds one whose folder already exists. Then one with a read-only file in the target | as P3, plus whether the files appeared on disk before the registry changed, and any notification that asks for a restart | A new pack reaches `succeeded` through a new top-level folder | Whether a re-import into an existing folder is visible at all. The `read_only_files` warning |
| P7 | **Closing the tab during a download** | Starts a larger download and closes the Fab tab | whether the import finishes, stops, or the editor faults | No fault | The wording of "keep the Fab tab open", and whether a closed tab should stop the job |
| P8 | **Starting PIE during an import** | Presses Play during an import. With the P0 veto, presses twice | whether the import finishes, and any fault or conflict | No fault | The wording of the PIE warning. Whether flagging is enough |
| P9 | **Library sync** | Signed in, asks for a sync | the log events in order; the row count over time | Rows appear and the job ends `succeeded` | **Whether the library works on 5.8.** If it fails there, section 17 (R1) applies |
| P10 | **Library values** | Nothing | the distinct values of `listing_type`, `source`, the distribution method and the image type; whether any id is a zero GUID; whether a row's id equals the id recorded by P3 to P6 | Every import kind of section 2.4 can be told apart | The `kind` mapping and the `in_project` join |
| P11 | **Sign-in from a fresh session** | In an editor started outside the launcher, with no saved session, signs in from Fab's page | what the person had to do, and whether another window or program was needed | The person can sign in without Hayba | The text of the `not_signed_in` hint |
| P12 | **Size on the page** | Looks at a listing before clicking | whether the page shows a download size | not a pass or fail | Whether `user_action` can point the person to the size |

### 13.3 What follows from a failed probe

| Probe | If it fails |
|---|---|
| P1 | `session` stays `unknown` in that configuration; the tools keep working |
| P2 | `fab_open` and the import start use the system browser and the longer `user_action` |
| P3, P4, P5 | the affected kind is not claimed as supported until the heuristics are fixed and the probe passes |
| P6 | packs ship with the known limit stated in the tool description |
| P7, P8 | a fault is reported upstream; the warning becomes stronger; nothing else changes, because Hayba cannot prevent either act |
| P9 | the library tool is 5.7-only in practice and says so (R1) |
| P10 | `kind` stays `unknown` and `in_project.join` stays `unverified` |

---

## 14. Per-engine differences

| Topic | UE 5.7 (Fab 0.0.10) | UE 5.8 (Fab 0.0.17) |
|---|---|---|
| Tab id | one tab, `FabTab`, registered at start-up (`F57/Private/FabBrowser.cpp:59`, `:226-243`) | tabs `Fab1`, `Fab2`, … created on demand (`F58/Private/FabBrowser.cpp:259-264`) |
| Opening a tab | `TryInvokeTab("FabTab")` focuses or spawns (`F57` `:103-113`) | every run of the entry point creates a new tab (`F58` `:134-144`, `:335-382`) |
| Rendering | one off-screen browser | `ExperienceMode`: standard is off-screen and spawns through the global tab manager (`F58` `:457-501`); performance is native and lives in Fab's own tab manager under the host id `FabBrowser.Host` (`F58` `:384-455`), so a global lookup by `Fab<N>` does not find it |
| No web browser | a modal dialog (`F57` `:284-289`) | an error tab, no modal (`F58` `:280-320`, `:344-348`) |
| Production base URL | `https://www.fab.com` (`F57/Private/FabSettings.cpp:67`) | `https://fab.com` (`F58/Private/FabSettings.cpp:57`) |
| Environments | Prod, Gamedev, Test, CustomUrl, with a `CustomUrl` property (`F57/Private/FabSettings.h:12-18`, `:48-50`) | Prod, Gamedev, Local (`F58/Private/FabSettings.h:12-17`) |
| `Fab.SetEnvironment` | `prod`, `gamedev`, `test` | `prod`, `gamedev`, `local` |
| Navigation guard | in production, a URL outside Fab is sent back and opened in the system browser (`F57/Private/FabBrowser.cpp:308-335`) | Fab web URLs are remapped to `/plugins/ue5/…`; other hosts load normally (`F58/Private/FabBrowser.cpp:1180-1229`) |
| Bridge version | `1.0.0` (`F57/Private/FabBrowserApi.cpp:328`) | `1.1.0` (`F58/Private/FabBrowserApi.cpp:450`) |
| Bridge entry points | `AddToProject` | plus **`InstallToProject`** and `InstallToEngine`, with a plugin install workflow (`F58/Private/FabBrowserApi.h:122-126`, `F58/Private/FabBrowserApi.cpp:213-287`) |
| Megascans parent materials | stay in the plugin's own content | copied to `/Game/Fab/Materials`, auto-saved, settings rewritten, once per project (`F58/Private/Workflows/QuixelImportWorkflow.cpp:220-312`) |
| Packs | no missing-plugin prompt | a notification with "Enable Missing and Restart" (`F58/Private/Workflows/PackImportWorkflow.cpp:68-195`) |
| Emporium | not checked | Fab skips its start-up (`F58/Private/FabModule.cpp:53-60`) |
| Workflow base class | plain class, raw delegate bindings | `TSharedFromThis`, shared bindings, completion deferred by a frame (`F58/Public/Workflows/FabWorkflow.h:43`, `:82-94`) |
| Closing a tab | the single browser is released 1.5 s later (`F57/Private/FabBrowser.cpp:380-418`) | the tab's bridge object is released 1.5 s later (`F58/Private/FabBrowser.cpp:839-938`) |
| Library sync source | identical file | identical file |
| Editor data storage interface | differs in layout from 5.8 | the satellite is compiled per engine, so this is a build matter, not a runtime one |
| EOS manager | same interface; line numbers differ by five | |
| `Fab.Build.cs` | | adds `bRequiresPlatformSDK = true` |

What Hayba does differently per engine is confined to `FHaybaFabPluginBackend`: the tab id, how a tab is opened, the base URL, the 5.7 modal guard, and the parent-materials warning. The handler, the machines and the shapes are the same.

---

## 15. Error handling

### 15.1 Codes

**Refusals. The command did not run.**

| Code | From | Emitted by | Detail keys | What the caller does |
|---|---|---|---|---|
| `editor_unsafe_restart_required` | router, P0 T1 | every command except the two job commands | `editor_health` | stop; the user restarts the editor |
| `pie_active` | router, P0 T2; also the import start's own check | `fab_library_sync`, `fab_open`, `fab_import_watch_start` | `pie` | wait until `editor_get_state.pie` is `none` |
| `lease_conflict` | router, P0 T8; also the job lease | `fab_library_sync`, `fab_open`, `fab_import_watch_start` | `lease` with the holder's owner | wait, or acquire |
| `owner_required` | router, P0 T8 | the same three | `lease` | send an owner |
| `bad_request` | handler | all | `param` | fix the call |
| `invalid_listing` | handler | `fab_open`, `fab_import_watch_start` | `reason` | pass an id or a Fab listing URL |
| `target_path_unsupported` | handler | `fab_import_watch_start` | `param` | drop the param; read `fab_location` afterwards |
| `licence_acceptance_unsupported` | handler | `fab_import_watch_start` | `param` | drop the param; the person accepts on the page |
| `fab_unavailable` | handler | all but the two job commands and `fab_status` | `reason` | see the hint per reason |
| `fab_contract_changed` | handler | the library commands | `missing` | report it; the engine's Fab plugin changed |
| `not_signed_in` | handler | `fab_library_sync` | `fab_tab_open` | open the Fab tab, let the person sign in, call again |
| `job_already_running` | handler | `fab_library_sync`, `fab_import_watch_start` | `active_job_id`, `kind` | follow or cancel that job |
| `job_unknown` | handler | the two job commands | `job_id` | the editor restarted, or the id is not a Fab job |
| `console_command_refused` | core, C6 | `editor_run_console_command` | `command_head` | do not run it |

**Job errors. The job ran and ended badly.** They appear in `error.code` of a job status.

| Code | Meaning |
|---|---|
| `fab_download_failed` | Fab logged a failed download |
| `fab_import_failed` | Fab logged a failed import, a failed unpack, or no importable files |
| `fab_import_rejected` | Fab did not handle the asset type. It may refuse the same listing until its tab is reopened |
| `fab_library_sync_failed` | Fab's library request failed; `reason` says how |
| `fab_library_sync_no_response` | nothing recognisable was logged within 30 s |
| `not_signed_in` | Fab found no signed-in account when it started the sync |
| `editor_unsafe_restart_required` | the editor became unsafe during the job |
| `fab_satellite_unloaded` | the satellite module shut down |

**Node-only codes.**

| Code | Meaning |
|---|---|
| `fab_satellite_missing` | the editor answered `Unknown command` for a `fab_*` command |
| `editor_busy` | polls failed at the transport while a job was running |
| `transport`, `timeout` | as for every tool |

**Warnings.** The command or job continued. Each is `{ "code", "message" }` in `warnings[]`.

`not_signed_in`, `fab_contract_changed`, `read_only_files`, `quality_tier_raw`, `megascans_parent_materials_will_be_saved`, `megascans_parent_settings_rewritten`, `lease_not_held`, `listing_not_shown_in_editor`, `download_stalled`, `fab_tab_closed_during_import`, `fab_already_processing`, `pie_started_during_job`, `unattributed_import`, `different_listing_imported`, `rows_skipped_zero_id`, `pump_budget_exceeded`.

Every refusal code is added to `IsWireRefusalCode` and to `KNOWN_UE_CODES`. Every advisory is `not_started` with `retry_unchanged_safe` true only for `pie_active`, `lease_conflict` and `job_already_running`.

### 15.2 Situations

| Situation | Behaviour |
|---|---|
| Fab's import holds the game thread | The pump does not tick and polls fail at the transport. Node reports `editor_busy` and keeps polling. The job resumes when the thread is free |
| Fab raises its `.rar` modal | Everything stops until the person answers. Hayba cannot prevent it. The tool description warns about it |
| The editor restarts during a job | The registry is empty afterwards. `fab_job_status` answers `job_unknown` with the hint that the content may still have been imported, and to look under `/Game/Fab` |
| A backend call faults inside a pump tick | The seam's `RunGuarded` contains it, and P0 T1 records it and marks the editor unsafe. The next tick finishes the job through the unsafe stop |
| The cache folder is huge or unreadable | `observed.cache_measured: false`. The job relies on the log event and the registry |
| Fab's record file is half-written | The read is retried on the next cadence. After `RecordGraceSeconds` the job ends as `unconfirmed` |
| Two agents start an import | The second gets `job_already_running`, or `lease_conflict` when it is another owner |
| The lease lapses because the game thread stalled longer than its lifetime | The pump acquires again on its next tick. If another owner holds it by then, the job continues with the warning `lease_not_held` |

---

## 16. Sequencing

### 16.1 Order

| Step | What | Depends on |
|---|---|---|
| 0 | **The P0 safety train lands first.** At least T1, T2, T3, T5 and T8 must be on the trunk, together with the lease feature they are built on, and with the removal of the four dead Fab registrations (commits `3555081d`, `394a4f00`, `57b832af`) | the P0 spec, sections 7.1 and 7.3 |
| 1 | Rebase `feat/fab-tools` onto the trunk. Confirm that no file under `N/src/tools/fab/` and no `hayba_fab_` name exists before the first Fab commit | step 0 |
| 2 | **Probes**, on the scratch hosts, in the order of section 13. The probe command needs only the satellite skeleton (module, handler registration, backend read functions) | step 1. A person is needed |
| 3 | **Build**, in the order below | the probes of the matching priority |
| 4 | Live ladder on 5.8, then 5.7 (section 16.3) | step 3 |
| 5 | ADR "Fab: drive, do not impersonate", with the next free number after the P0 train's ADRs. Changelog, `docs/ARCHITECTURE.md`, `CONTEXT.md`, `CONTRIBUTING.md:40` | step 4 |

P1 and P2 can start as soon as the skeleton builds on the scratch host. The import heuristics are not written before P3 and P4 have results.

### 16.2 Build order

| # | Piece | Verifies |
|---|---|---|
| B1 | Core companion changes C1 to C7, with their tests | the registry extension and the seam |
| B2 | The satellite skeleton, `fab_status`, feature detection, `hayba_fab_login_status` | P1 |
| B3 | `fab_open`, `hayba_fab_open` | P2 |
| B4 | The watch machine and its pure tests; the fake backend | section 12.2 |
| B5 | `fab_import_watch_start`, the two job commands, the three job tools. **glTF/FBX and Megascans 3D first** | P3, P4 |
| B6 | Megascans surfaces | P5 |
| B7 | UE packs | P6 |
| B8 | The sync machine, the two library commands, `hayba_fab_library_list` | P9, P10 |

Each piece goes through all five layers before the next one starts. Each lands as one or more commits that build and pass both suites on their own.

### 16.3 The live ladder

On the scratch host, after the automation and Node suites are green:

1. `ping`, then `hayba_fab_login_status`.
2. Disable the engine's Fab plugin, restart, and confirm `fab_satellite_missing` and that the core loads without a dialog (SC6). Enable it again.
3. `hayba_fab_open` with a listing, and with a query.
4. `hayba_fab_add_to_project` for each import kind in priority order. The person clicks. Compare the result with a by-hand listing of the content folder (SC1, SC2).
5. Start PIE by hand and confirm the three refusals.
6. `hayba_fab_library_list` with `refresh`.
7. Search the log for token-shaped strings (SC3).

### 16.4 The parallel lane

This work runs in parallel with the blueprint bulk builder's C++ lane. The two lanes share four Node files and no C++ file.

| Shared file | Rule |
|---|---|
| `N/src/legacy-commands/sidecar.json` | the Fab entries are one appended block |
| `N/src/tools/index.ts` | one hunk: the Fab descriptor block and the `inferDir` rule |
| `N/src/tools/tool-executor.ts` | one hunk each for the codes and for `NON_IDEMPOTENT` |
| `N/src/tools/routing/packs.yaml` | six lines in the connectors pack |

- Neither lane edits the other's block.
- The lane that lands second rebases and re-runs both suites.
- New tests go in new files.
- The Fab lane does not touch `HaybaMCPBlueprintHandler.cpp` or `HaybaBlueprintOps`. The bulk builder does not touch `unreal/HaybaMCPFab`, the job registry or the satellite seam.

### 16.5 Commits

Conventional messages. No co-author line. Work lands on a feature branch and is pushed when ready.

---

## 17. Risks

| # | Risk | Effect | What the design does |
|---|---|---|---|
| R1 | **The 5.8 library sync may be broken upstream.** Fab 5.8 sends the request to `https://fab.com`; 5.7 sends it to `https://www.fab.com`. If the bare host answers with a redirect, a client that follows it may drop the authorization header, and the request fails. We have not observed this ourselves | The library would be unavailable on 5.8, the first consumer's engine | Probe P9 decides. **If it fails, `hayba_fab_library_list` reports:** `ok: false`, `code: "fab_library_sync_failed"`, `sync_error.reason` (for example `request_failed_or_not_json`), `sync_state: "failed"`, `upstream_suspected: true`, `engine_version`, `fab_version`, `items` from the last good snapshot with `stale: true` or an empty array, and the hint "Fab's own library request failed. It is Fab's request, not Hayba's, and Hayba cannot repair or replace it. Your library is still visible in the Fab tab; call hayba_fab_open." It never reports an empty library. The other five tools are unaffected |
| R2 | Fab's private names change: settings properties, column structs, the console command, log wording | A tool degrades or stops | Feature detection reports `fab_contract_changed`. The machines fail closed on unknown log wording. `Hayba.Fab.Contract.ProbeOnThisEngine` catches it at build time per engine |
| R3 | A failed library refresh empties the table, because Fab removes every row first | The previous list is lost | The in-memory snapshot serves it with `stale: true` |
| R4 | The job attributes someone else's changes to the import: the person imports a second thing, or another tool writes under `/Game/Fab` | Wrong `imported_paths` | One job at a time; `attribution` and `listing_match` say how strong the evidence is; the lease marks the folder busy for other agents |
| R5 | Closing the Fab tab during a download, or starting PIE during an import, faults the editor | A lost session | Probes P7 and P8. Hayba warns up front and flags. It cannot prevent either act |
| R6 | Fab's modal dialog, or a long import, holds the game thread | Every lane stalls | `editor_busy` in Node; the description warns; nothing in Hayba opens a modal |
| R7 | The job lease blocks agent PIE for up to `timeout_s` while nothing happens | An agent waits | The default is 900 s; `hayba_fab_job_cancel` releases at once; the refusal names the owner and the label |
| R8 | Measuring a large cache costs game-thread time | Hitches | Once a second, bounded at 20,000 entries, with a budget warning |
| R9 | A satellite in a development host is a link to another checkout, so a branch's satellite is never the one that runs | Green tests for the wrong code | The scratch host holds copies |
| R10 | A build reports success without the new files | A test that never ran reports green | The exact-name manifest |
| R11 | Re-importing into a folder that already exists produces no registry additions | `timed_out` although Fab finished | Registry updates are watched too; probe P6 decides whether that is enough; the limit is stated until then |
| R12 | Fab's log carries sensitive text | A leak through a capture | Event codes only; `LogEOSSDK` dropped; both redaction layers; the log search after every probe |
| R13 | The P0 names used here change during P0's implementation | This spec goes stale | Section 3.3 is the single list to update; the contract test fails when a code is missing on either side |

---

## 18. Open verifications

These were not settled by reading source. Each has an owner step.

| # | Question | Settled by |
|---|---|---|
| V1 | Does a query over rows that have a column found at run time, with its data read through `GetColumnData(Row, UScriptStruct*)`, build and work on both engines? | B8, on both scratch hosts |
| V2 | Can a tool-menu entry's action be run from code on 5.8 without opening the menu? | B3, P2 |
| V3 | Does the widget walk find the browser of a natively rendered tab? | P2 |
| V4 | Are listing ids always GUIDs with hyphens? | P2, P3 |
| V5 | Is Fab's recorded id the listing id, and is it the library row's id? | P3, P4, P10 |
| V6 | Does the registry report additions for a pack after Fab's scan, and updates for a re-import? | P6 |
| V7 | Are the packages of an Interchange import dirty when the import ends? | P3, P4 |
| V8 | Is there exactly one unnamed EOS platform in a plain project? | P1 |
| V9 | Does the search URL of section 6.4 show results in the plugin's page? | P2 |
| V10 | Does disabling the engine's Fab plugin disable the satellite quietly, without a dialog? | live ladder step 2 |
| V11 | Does the recorded-id config section have the name and the form this spec assumes, and where does the editor write it? | P3 |
| V12 | Is calling EOS account counts on Fab's platform safe before any Fab tab has opened? | P1 |
| V13 | Do the P0 command-set, refusal-set and lease-table names match this spec once P0 is implemented? | step 1 of section 16.1 |
| V14 | Does loading a `/plugins/ue5/…` URL directly behave the same as the remapped web URL on 5.8? | P2 |
| V15 | Do the sidecar tests accept an entry with `agent_callable: false` and `has_ts_wrapper: true`? If not, the seven entries use `agent_callable: true`, as the 44 wrapped commands do today; the editor-side refusals and the no-retry rule hold either way | B2 |

---

## 19. Files

**New.**

- `unreal/HaybaMCPFab/` (section 5.1)
- `P/Public/HaybaMCPSatelliteHost.h` and its implementation
- `N/src/tools/fab/fab-shapes.ts`, `fab-poll.ts`, `fab-scrub.ts`, `login-status.ts`, `library-list.ts`, `add-to-project.ts`, `job-status.ts`, `job-cancel.ts`, `open.ts`
- the Node tests of section 12.3
- `N/scripts/fab-expected-automation-tests.txt`
- an ADR, "Fab: drive, do not impersonate"
- `docs/superpowers/specs/2026-09-28-fab-tools-probes.md`, written by the probes

**Moved.**

- `P/Private/HaybaMCPJobRegistry.h` to `P/Public/HaybaMCPJobRegistry.h`

**Modified, C++.**

- `P/Private/HaybaMCPJobRegistry.cpp`
- `P/Private/handlers/HaybaMCPBuildHandler.cpp` (`build_status`)
- `P/Private/handlers/HaybaMCPEditorHandler.cpp` (C6, C7)
- `P/Private/HaybaMCPCommandHandler.cpp` (`IsWireRefusalCode`)
- `P/Private/HaybaMCPCommandSets.h`, `P/Private/HaybaMCPAccessPolicy.h` (after P0)
- `P/Private/HaybaMCPSecretRedaction.cpp` (C5)
- the P0 drift tests

**Modified, Node.**

- `N/src/legacy-commands/sidecar.json`
- `N/src/tools/index.ts`
- `N/src/tools/tool-executor.ts`
- `N/src/tools/routing/packs.yaml`
- `N/src/security/secret-redaction.ts` and its test
- `N/src/tools/no-stub-wrappers.test.ts`
- `N/src/tools/__tests__/wire-command-names.test.ts`

**Modified, docs.**

- `CHANGELOG.md`, `N/CHANGELOG.md`
- `docs/ARCHITECTURE.md` (the satellite section), `CONTEXT.md`, `CONTRIBUTING.md`
