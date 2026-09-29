# Fab tools (guided hand-off): design spec

- **Date:** 2026-09-28. Revised 2026-09-29 after review round 1 (Appendix B).
- **Branch:** `feat/fab-tools` (worktree `.worktrees/fab-tools`), based on `origin/main` at `a5ceaa40`.
- **Status:** design for implementation planning. The guided hand-off ("Stage 1") was approved by the maintainer on 2026-09-28. Stage 2 is not approved (section 2.2). This spec is **five implementation plans**, not one (section 16.2).
- **Depends on:** the P0 safety train, `docs/superpowers/specs/2026-09-28-p0-safety-train-design.md` on `fix/p0-safety`. This spec calls it "the P0 spec", cites its tasks as T1 to T10, and cites its rulings as "P0 ruling R<n>".
- **Supported engines:** Unreal Engine 5.7+. 5.7 and 5.8 are both covered, and they differ (section 14). An engine after 5.8 takes the 5.8 path, and the contract probe (section 5.5) reports what changed.
- **Conventions:**
  - `P` = `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit`. `N` = `mcp-tools/hayba-mcp`.
  - Hayba line numbers are at `a5ceaa40` unless a citation says `@leases`, which means `d5a1a205`, the base of `fix/p0-safety`. The C++ under `unreal/` is unchanged between `d5a1a205` and the tip of `fix/p0-safety`.
  - `F57` / `F58` = `<engine>/Engine/Plugins/Fab/Source/Fab` in the UE 5.7 and UE 5.8 installs (Fab plugin 0.0.10 and 0.0.17, `Fab.uplugin`). `E57` / `E58` = `<engine>/Engine/Plugins/Online/EOSShared/Source/EOSShared`. A citation with only `F58` holds for 5.8; one that names both was checked in both.
  - "Wire command" means the string sent over the TCP socket. "Tool" means an MCP tool name. They are different namespaces (`CONTEXT.md:63-67`).
  - "The first consumer project" is the project that asked for these tools. It runs UE 5.8.
  - **The trunk is `main`.** The pull request targets `main`. "On the trunk" means reachable from `origin/main`.
  - Risks are numbered RK1 to RK15 (section 17), so they cannot be mistaken for P0 rulings.
  - Every code this spec adds starts with `fab_`. The one exception is `console_command_refused`, which the core emits.
  - Byte counts, byte params and byte counters are 64-bit integers.

---

## 1. Summary

Hayba gets seven Fab tools that drive Epic's own in-editor Fab plugin and never stand in for it.

- `hayba_fab_login_status` reports whether Fab is usable and whether a session is signed in. It counts accounts; it reads no credential.
- `hayba_fab_open` shows a listing or a search in Fab's own tab. It returns no search data.
- `hayba_fab_add_to_project` is a hand-off. Hayba opens the listing in Fab's tab. The person reads the licence and clicks **Add to Project**. A Hayba job watches the import and returns `imported_paths[]` and `unsaved_packages[]`, so the caller can post-process and save by pathspec.
- `hayba_fab_job_status` and `hayba_fab_job_cancel` follow and stop that job.
- `hayba_fab_import_describe` reads what an import left in the project from Fab's own record. It needs no job, so it also works after an editor restart.
- `hayba_fab_library_list` asks Fab to run its own library sync and reads the rows Fab stored.

The editor side is a new optional satellite plugin, `unreal/HaybaMCPFab`, with eight wire commands. Hayba never saves, never accepts a licence, and never holds a token.

The import logic is a pure state machine with an injected clock. It leaves `waiting_for_user` only on Fab's own log line for the click. It is tested against a fake backend and against recordings of real imports. The recordings come from twelve probes that a person runs on a throwaway scratch project.

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
| G6 | Be testable without Fab, a network or an account: a fake backend, pure state machines, and replayed recordings. |
| G7 | Describe a finished import without a job, from Fab's record and the asset registry. |

### 2.2 Non-goals

**Stage 2 is a non-goal: headless download, and search that returns data.** It is recorded here so nobody builds it by accident.

- Nothing in either engine turns a listing id into a download. The only entry point is `UFabBrowserApi::AddToProject(DownloadUrl, FFabAssetMetadata)` (`F58/Private/FabBrowserApi.cpp:77-211`, `F57/Private/FabBrowserApi.cpp:38`). Engine C++ never calls it. It is called by the Fab web page through the JavaScript bridge that Fab binds into its own browser (`F58/Private/FabBrowser.cpp:619`), and the page supplies the signed download URL.
- The only other source of that URL is Fab's web service, called with the user's bearer credential. A headless import would therefore put that credential inside Hayba's process. The rule for these tools is that no credential passes through Hayba.
- That web service is undocumented, and Fab's terms have not been reviewed for automated use.
- The Fab plugin has no search in either engine. Results exist only inside the page.

Stage 2 needs an explicit maintainer decision after a person has read Fab's terms. Two checks belong to it and are **not** run under this spec: that terms review, and any request to a Fab web endpoint made by Hayba.

**The one network request a Hayba command can cause.** `fab_library_sync` asks Fab to run its own library sync. Fab then sends its own authenticated request, one per page. No other Hayba command causes Fab to make a network request. Hayba itself sends none. Section 11.9 has the limits.

Also out of scope, each with its reason:

| Non-goal | Reason |
|---|---|
| Download size before the click | Only Fab's page holds the size. Hayba reads no page content |
| Byte-accurate progress, a total, a percentage | Fab's download queue is private (`F58/Public/FabDownloader.h:112-121`) |
| A real download cancel | The same private queue. Only Fab's own notification can cancel |
| A caller-chosen target path | Fab's workflows choose the folder (section 3.2) |
| **Plugin installs and MetaHumans** are out of scope for verification | The first consumer does not need them (section 2.4). No probe covers them and no success criterion depends on them. Section 8.7 says what the job does when it meets one |
| Saving anything | The caller saves only what it chooses, and a save can meet read-only files (section 11.4) |
| Accepting or pre-accepting a licence | Consent must be the person's |
| Signing in on the user's behalf | No credential passes through Hayba |
| Fab environments other than production | They are not public, and their base URLs differ per engine (section 14) |
| The separate Quixel Bridge plugin | It has its own sign-in and keeps a credential on disk, which Hayba must never read |
| Platforms other than the Windows editor | The core's fault guard and the scratch hosts are Windows-only |

### 2.3 Success criteria

| # | Criterion | How it is checked |
|---|---|---|
| SC1 | **Binding for priority 1 (section 2.4) on 5.8:** the job reaches `succeeded`, `imported_paths` equals the set of packages the import added or updated, and `unsaved_packages` equals the dirty or not-yet-on-disk subset. For priorities 2 and 3, and for every kind on 5.7, the kind is either verified the same way or named as unverified in the tool description. When `paths_capped` is true, the criterion applies to `counts` and `imported_roots` | The replay tests of section 12.2, then the live ladder in section 16.3. The by-hand comparison is the Content Browser listing of the candidate roots before and after the import, plus a diff of the project's `Content` folder on disk for `saved_by_fab` |
| SC2 | On 5.8 in a fresh project, the first Megascans import reports the parent-material packages under `/Game/Fab/Materials` in `imported_paths` and in `saved_by_fab`, not in `unsaved_packages`, and the mesh and its textures in `imported_paths` as well | `Hayba.Fab.Watch.Replay.megascans_3d_first.58`, and probe P4 |
| SC3 | No response, progress record, job output or log line **of a Hayba log category** carries a token-shaped string | `Hayba.Fab.Handler.ResponsesCarryNoTokenShapes`, the Node redaction test, and a search of the scratch host's log after every probe (section 13.1) |
| SC4 | No Fab pump tick costs more than 5 ms of game-thread time in real use | The probe recorder writes the gather cost of every tick. The recordings of P3 to P6 hold no tick above 5 ms, and the live ladder ends without the warning `pump_budget_exceeded`. The fake-backend test proves only that the warning fires |
| SC5 | Every refusal carries a top-level `code` that Node knows | `fab-contract.test.ts` (section 12.3) |
| SC6 | With the engine's Fab plugin disabled in the `.uproject`: Fab stays disabled, the core and the satellite load without a dialog, and every Fab tool answers `fab_unavailable` with reason `fab_disabled`. With the satellite not installed, every Fab tool answers `fab_satellite_missing` | Live ladder step 2, `Hayba.Fab.Handler.StatusShapes`, and `fab-unknown-command.test.ts` |
| SC7 | Every automation test named in section 12.2 reports Success under the filter `Hayba`, checked by exact name | The manifest check in section 12.4 |
| SC8 | When Fab's own library sync does not succeed, `hayba_fab_library_list` answers `ok:false` with the code from the table in section 7.7. It never presents an empty list as an empty library | `Hayba.Fab.Handler.LibraryReadAfterFailedSyncIsNotEmptySuccess`, `fab-library-list.test.ts`, and probe P9 |
| SC9 | On a Fab version whose click line is verified, a job never leaves `waiting_for_user` and never succeeds without that line | `Hayba.Fab.Watch.NoExitFromWaitingWithoutClick` |
| SC10 | A status reply reads `terminal: true` only after the result arrays are stored | `Hayba.Fab.Handler.TerminalOnlyAfterArraysStored` |

### 2.4 First-consumer priorities (binding for ordering)

Build, probe and verify in this order.

1. **glTF/FBX imports, and Megascans 3D imports.** The Megascans check includes the parent materials that a Megascans import copies to `/Game/Fab/Materials` and auto-saves on 5.8.
2. **Megascans surfaces.**
3. **UE packs** (low priority).

Plugins and MetaHumans are not verified.

For `hayba_fab_add_to_project` the core contract is two keys, `imported_paths[]` and `unsaved_packages[]`.

- They are present in the start reply and in every status reply of an import job.
- They are always arrays.
- They are never renamed.
- `unsaved_packages` is the list to save by. `imported_roots` is for information (section 6.5).

### 2.5 What these tools cannot do

This list is the single source for the tool descriptions (section 7) and the changelog.

| # | Limit |
|---|---|
| L1 | They download nothing. Fab downloads, after the person's click |
| L2 | They accept no licence |
| L3 | They sign nobody in |
| L4 | They save nothing |
| L5 | Search returns no data. It shows results to the person |
| L6 | The size is unknown before the click |
| L7 | There is no total and no percentage. Progress is a state plus the bytes seen on disk |
| L8 | Cancel stops Hayba watching. It does not stop Fab |
| L9 | The caller cannot choose the target folder |
| L10 | The library has no size and no engine-compatibility field |
| L11 | The library may not work on 5.8 until probe P9 passes (RK1) |
| L12 | Plugins and MetaHumans are unverified |
| L13 | Job ids do not survive an editor restart. `hayba_fab_import_describe` does |
| L14 | A Fab archive that holds a `.rar` file makes Fab show a dialog that blocks the editor until the person answers |

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
- A satellite must add capability that the always-available tool surface cannot reach (`docs/adr/0008-satellite-plugins-earn-their-place.md`). Fab qualifies: Python cannot count EOS accounts, read the editor data storage rows, or watch Fab's log and the Interchange manager, and Fab is optional per project.

**A plugin reference enables its target.**

- The plugin manager enables every plugin that an enabled plugin lists as a dependency. It does not consult the project's own entry for that dependency (`<engine>/Engine/Source/Runtime/Projects/Private/PluginManager.cpp:2552-2597` in 5.8).
- `Optional: true` does not change that. It only skips a dependency that is missing on disk (`:2475-2482`).
- A satellite that lists `Fab` would therefore turn Fab back on in a project that turned it off. Section 5.2 follows from this.

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
| 1. Declare and implement | the handler's `GetCommands()` and `Handle()` | `wire-command-names.test.ts:43-55` collects every `TEXT("…")` literal of the scanned source, and the sidecar keys |
| 2. Sidecar descriptor | `N/src/legacy-commands/sidecar.json` (`params`) | For the legacy handler: `N/scripts/check-legacy-wrappers.mjs`, whose first invariant reads only `HaybaMCPLegacyHandler.cpp`. For a satellite nothing checks it today; `fab-contract.test.ts` becomes that check (section 12.3) |
| 3. `returns` on that entry | same file (`LegacyCommandEntry.returns`, `N/src/legacy-commands/index.ts:56-64`) | the sidecar description tests |
| 4. `agent_callable` and `has_ts_wrapper` | same file; `isLegacyTarget` builds a generated tool only for `agent_callable && !has_ts_wrapper` (`N/src/tools/legacy-tool-factory.ts:44-46`, `:189-206`) | `check-legacy-wrappers.mjs:147-161` compares `has_ts_wrapper` with the literal `executeCommand('<name>')` calls |
| 5. `list-tool-categories` | `N/src/tools/code-mode/list-tool-categories.ts` (`DOMAINS` at `:31`, `domainOf` at `:233-252`) | the guard that every registered tool appears in its output |

Raw TCP works after layer 1, so a command looks finished long before an agent can reach it.

Because `wire-command-names.test.ts` treats every `TEXT("…")` literal as a command name, a JSON key written as a literal counts as a command too. No literal in the satellite may therefore equal one of the four dead wire names (section 12.3).

**The dead Fab tools.**

- `origin/main` still registers four tools that call commands no handler implements: `N/src/tools/fab/{login-status,library-list,marketplace-search,download}.ts`, `N/src/tools/index.ts:50-53` and `:3315-3367`, `N/src/tools/routing/packs.yaml:29-32`, `N/src/tools/schema-single-source.test.ts:111-145`, and the exemption list in `wire-command-names.test.ts:97-105`.
- They are removed on `fix/p0-safety` by commits `3555081d`, `394a4f00` and `57b832af`. That removal also dropped the `hayba_fab_` rule from `inferDir()` (`N/src/tools/index.ts:3972` here) and from `domainOf()` (`list-tool-categories.ts:236` here).

### 3.2 The engine's Fab plugin

| Fact | Where |
|---|---|
| The module starts only in an interactive editor, not in a commandlet. On 5.8 it also skips its own start-up when the `Emporium` plugin is enabled. | `F58/Private/FabModule.cpp:51-60`; 5.7 has no Emporium check (`F57/Private/FabModule.cpp:51`) |
| Fab signs in only when a tab opens: `LoginUsingPersist()` is called from tab creation. | `F58/Private/FabBrowser.cpp:335-337`; `F57/Private/FabBrowser.cpp:275-277` |
| A new 5.8 tab first loads a local index page. Its script replaces the location with Fab's URL as soon as the bridge answers, or 500 ms later. | `<engine>/Engine/Plugins/Fab/ThirdParty/index.html`; `F58/Private/FabBrowser.cpp:326` |
| Fab creates its EOS platform through the options overload, which leaves the platform's config name empty. | `F58/Private/FabAuthentication.cpp:100`; `E58/Private/EOSSDKManager.cpp:654-664` sets the name only in the named overload, `:666-716` is the options overload |
| Active platforms can be listed through a public interface. | `E58/Public/IEOSSDKManager.h:134`, `E58/Private/EOSSDKManager.cpp:718-735` (same in `E57`) |
| Fab's auth handle is set only inside its login functions. | `F58/Private/FabAuthentication.h:111`, `F58/Private/FabAuthentication.cpp:268`, `:298`, `:324` |
| The console command `EOSSDK INFO` logs the access, refresh and id values in non-shipping builds. **The lines are in the category `LogEOSShared`**, because the macro that prints them logs there. `LogEOSSDK` is the separate category of the SDK's own callback. The command is parsed without regard to case. | macro at `E58/Private/EOSSDKManager.cpp:1263` (`E57` `:1258`); values at `E58` `:1358`, `:1364`, `:1386`; callback category at `E58` `:115`; parsing at `E58` `:1222-1230` (`E57` `:1217-1225`) |
| Console commands: `Fab.ShowSettings`, `Fab.Logout`, `Fab.Login`, `Fab.ClearCache`, `Fab.SetEnvironment`, `Fab.TEDS.MyFolderIntegration [batch]`. | `F58/Private/FabConsoleCommands.cpp:12-89` (same names in `F57`) |
| The library sync removes every row first, then requests the account's library from Fab's service with Fab's own credential, one page at a time. It queues the request for the next page **before** it stores the current one. If it cannot copy its credential, it logs nothing. The file is byte-identical in 5.7 and 5.8. | `F58/Private/Teds/FabMyFolderIntegration.cpp:31-41`, `:43-85`, `:105-114`, `:162` |
| The sync logs distinct lines: not signed in (`:83`), a response arrived (`:91`), a page was parsed (`:162`), and five separate errors (`:166`, `:171`, `:176`, `:181`, `:186`). The error at `:166` is logged whenever a page's result list is missing **or empty**, and it prints the whole response body. | same file |
| Rows go to the editor data storage table `Fab` with a name column, a Fab object column and a URL column. | `F58/Private/Teds/FabMyFolderIntegration.cpp:21-24`; columns at `F58/Private/Teds/FabMyFolderIntegration.h:38-72` |
| The Fab object and name columns are declared in a private Fab header. The URL and web-image columns are public engine types. | `<engine>/Engine/Source/Runtime/TypedElementFramework/Public/Elements/Columns/TypedElementWebColumns.h:13-48` |
| The editor data storage plugins are marked experimental. | `<engine>/Engine/Plugins/Experimental/EditorDataStorage/EditorDataStorage.uplugin:15` |
| Fab records imports in `UFabLocalAssets.PathsListingID`, a config map from a `/Game` folder to an id, stored in `EditorPerProjectUserSettings`. The write runs on a task-graph thread. It first **removes every entry whose folder the asset registry does not know**, then saves. | `F58/Private/Utilities/FabLocalAssets.h:14-21`, `:25-53` (identical in `F57`) |
| "View in Fab" builds `<base>/plugins/ue5/listings/<id>` from that recorded id. | `F58/Private/FabBrowser.cpp:223`, `:956-975`; `F57/Private/FabBrowser.cpp:192`, `:245-268` |
| The cache location is the `CacheDirectoryPath` property of `UFabSettings`. `FFabAssetsCache::GetCacheLocation()` only returns that property. Its default is `<user temp>/FabLibrary`, so the cache is shared by every project and every engine on the machine. | `F58/Private/Utilities/FabAssetsCache.cpp:29-32`; `F58/Private/FabSettings.h:68` (`F57` `:62`) |
| Every download goes to `<cache>/<AssetId>`: HTTP downloads, and the staging folder of a pack. | `F58/Private/Workflows/GenericImportWorkflow.cpp:33`, `F58/Private/Workflows/QuixelImportWorkflow.cpp:83`, `F58/Private/FabDownloader.cpp:314` |
| An HTTP download streams to `<file>.download`. A cached file is reused and the request is cancelled. | `F58/Private/FabDownloader.cpp:82-86`, `:95-113` |
| Packs download through BuildPatch and are installed into the project folder. | `F58/Private/FabDownloader.cpp:312-315`, `F58/Private/Workflows/PackImportWorkflow.cpp:33-44` |
| The downloader logs its own failures: a file error, a module that cannot load, `Invalid Manifest`, `Invalid pack - …`. | `F58/Private/FabDownloader.cpp:125`, `:137`, `:154`, `:215`, `:236`, `:321`, `:337` |
| Fab's download queue is private. Only the pack notification has a Cancel button, and pressing it logs `Import Cancelled`. | `F58/Public/FabDownloader.h:112-121`, `F58/Private/Workflows/PackImportWorkflow.cpp:312-353` (the line at `:327`) |
| `AddToProject` logs `Add listing to project - <id>` and `Listing type - <type>` **before any workflow runs**, whether the asset is cached or not. It ignores a listing that is already being processed. Dragging a listing into the level logs `Drag listing to project - <id>`. | `F58/Private/FabBrowserApi.cpp:80-90`, `:301-302`; `F57/Private/FabBrowserApi.cpp:45-51`, `:180-181` |
| On 5.8 a plugin listing goes through other entry points, which log `Install plugin to project - <id>` or `Install plugin to engine - <id>`. | `F58/Private/FabBrowserApi.cpp:224`, `:262` |
| The listing type decides the workflow: `unreal-engine` is a pack; a Megascans flag selects the Megascans workflow whatever the type; `gltf`, `glb` and `fbx` are generic; `metahuman` is a MetaHuman; any other type logs `Asset type not handled`. | `F58/Private/FabBrowserApi.cpp:92-210` |
| On 5.8 the list of active workflows belongs to the bridge object of one tab. The "already being processed" check is therefore per tab. | `F58/Private/FabBrowserApi.h:100`; `F58/Private/FabBrowser.cpp:619` |
| `UFabBrowserApi` exposes `GetAuthToken` and `GetRefreshToken` as reflected functions. `UFabSettings` has a `CustomAuthToken` property. Fab's EOS client settings live in the asset `/Fab/Data/FabEos`. | `F58/Private/FabBrowserApi.h:143-147`, `F58/Private/FabSettings.h:54-56`, `F58/Private/FabAuthentication.cpp:30` |
| `FabModule.h` defines the global macro `MS_MODULE_NAME`. | `F58/Public/FabModule.h:7` |
| Fab logs through the category `LogFab`: ordinary lines at Display, errors at Error. | `F58/Private/FabLog.h:9-11` |
| The Interchange manager says whether an import is active and announces finished imports through public delegates. | `<engine>/Engine/Source/Runtime/Interchange/Engine/Public/InterchangeManager.h`: 5.7 `:488-490`, `:808`; 5.8 `:516-518`, `:841` |
| The asset registry says whether it is still loading. | `<engine>/Engine/Source/Runtime/AssetRegistry/Public/AssetRegistry/IAssetRegistry.h`: 5.7 `:1019`, 5.8 `:1025` |

What each import kind does, from source. The probes confirm it.

| Kind | Workflow | Assets land in | Fab's recorded key | Saved by Fab? |
|---|---|---|---|---|
| glTF, GLB, FBX | `FGenericImportWorkflow` | `/Game/Fab/<Name>` (`F58/Private/Workflows/GenericImportWorkflow.cpp:204-209`) | the same folder (`:219`). It is written in the completion callback, after every import task has finished | No. The import task uses `bSave = false` (`F58/Private/Importers/GenericAssetImporter.cpp:144`, `F57` `:143`) |
| Megascans: 3D, Plants, Decals, Imperfections, Surfaces | `FQuixelImportWorkflow` | `/Game/Fab/Megascans/<SubType>/<Name>_<MegascanId>/<Tier>` (`F58/Private/Workflows/QuixelImportWorkflow.cpp:325`) | the parent of the tier folder (`:336`), written in the completion callback | No for the asset (Interchange). On 5.8 the parent materials are copied and auto-saved (next row) |
| Megascans parent materials, 5.8 only | `CopyMaterialsToProject` | `/Game/Fab/Materials` | none | Yes: `AdvancedCopyPackages(..., bForceAutosave = true, ...)`, then the Megascans parent settings are rewritten and saved. It runs **before** the import starts (`:317`), and only when `Content/Fab/Materials` does not exist (`:220-312`). It logs `Copying Fab parent materials to …` (`:240`) and, on failure, `AdvancedCopyPackages failed, …` (`:282`). 5.7 has no such step |
| UE pack | `FPackImportWorkflow` | `/Game/<PackFolder>` (`F58/Private/Workflows/PackImportWorkflow.cpp:295-304`) | the same folder. It is recorded **before** the folder is scanned (`:300-302`), so the record's own clean-up can remove the entry again | Files are written to disk directly. On 5.8 a notification may offer "Enable Missing and Restart" (`:68-195`) |
| MetaHuman | `FMetaHumanImportWorkflow` | `/Game/Fab/MetaHuman` (`F58/Private/Workflows/MetaHumanImportWorkflow.cpp:58-69`) | none: it never records an entry | not verified |
| Plugin, 5.8 only | `FPluginInstallWorkflow` | the engine or project plugin folder | none | out of scope |

Hazards Hayba inherits and cannot prevent:

- A `.rar` inside a generic archive logs a line and raises a **modal** dialog. After the person answers, the import continues without those files (`F58/Private/Workflows/GenericImportWorkflow.cpp:82-94`).
- A Megascans import with an unknown sub-type logs an error and never completes (`F58/Private/Workflows/QuixelImportWorkflow.cpp:367-370`). Fab then refuses the same listing again, because the workflow stays in its active list (`F58/Private/FabBrowserApi.cpp:80-87`).
- A failed pack download ends its workflow without a line of its own (`F58/Private/Workflows/PackImportWorkflow.cpp:284-291`). The downloader's lines above cover three of the causes; the rest leave no trace.
- When a 5.8 tab closes, its bridge is unbound at once, and the object that owns the workflows is released 1.5 s later (`F58/Private/FabBrowser.cpp:839-938`).

### 3.3 What the P0 train provides

These pieces are reused by their P0 names. None of them exists in this worktree yet.

| P0 piece | P0 spec | How the Fab tools use it |
|---|---|---|
| `pie_active` refusal | T2, router slot 2. `PieRuleFor` defaults to Refuse | The router refuses `fab_open`, `fab_library_sync` and `fab_import_watch_start` during PIE. Nothing needs to be listed for that: it is the default. **The handler emits no `pie_active` of its own** |
| `editor_unsafe` and `editor_unsafe_restart_required` | T1, router slot 1, allowlist fails closed | The router refuses every Fab command except the two job commands. The job pumps stop themselves (section 10.3) |
| Asset leases, `asset:<path>` | T3 (seam S1, `AssetPackageKey`, `FindAssetHolders`), D5 | The import job holds `asset:/Game/Fab` exclusively **from the click to the end** (D-F6), so `editor_get_state.building` lists it and an agent's `editor_start_pie` answers `asset_busy`. The spec writes the display form; the table stores the lower-cased key `asset:/game/fab` |
| `AssetWriteCommands` | T3 | **Not changed.** No Fab command is a row, because no Fab command names an asset in a param (D-F16) |
| `package_read_only` preflight | T5, `HaybaSaveVerify::FindReadOnlyPackageFiles` in `Public/HaybaMCPSaveVerify.h` | The import preflight lists read-only files as warnings. The Fab tools never save, so they never emit the code. The caller meets it later, when it saves `unsaved_packages` |
| The shared command sets | T1 / P0 ruling R12, `P/Private/HaybaMCPCommandSets.h` | Five Fab commands are added (section 6.0), and every size pin moves with them |
| `IsWireRefusalCode` and `MakeGateRefusal` | T5 and T1, section 3.0 of the P0 spec | Handler refusals use the structured `Ok(Data{ok:false, code, …})` channel (P0 ruling R3). `MakeGateRefusal` stays the router's; the handler never builds a router code |
| `KNOWN_UE_CODES` | T1 onwards | The Fab refusal codes and job error codes are added to it (section 15.1) |
| The job registry | existing core code (section 3.1) | Extended with progress and a cancel flag (section 10) |
| The user Play veto | T10 | While the job holds its lease, the person's Play button is vetoed with a double-press override |

### 3.4 Branch reality

- `origin/main` at `a5ceaa40` contains neither the lease feature nor the P0 train. `d5a1a205` is not an ancestor of `a5ceaa40`; their merge base is `5c4aefed`.
- This worktree therefore has no `HaybaMCPLeaseManager`, no `HaybaMCPAccessPolicy.h`, no `HaybaMCPBatchPolicy.h` and no ADR-0010.
- The pure batch machine that the watch machine is modelled on, `HaybaMCPBatch::FMachine`, exists only `@leases` (`P/Private/HaybaMCPBatchPolicy.h:228-247`).
- The implementation branch is rebased onto the trunk after the P0 train has merged (section 16). This spec is written against that future tree and says so wherever it matters.
- The probes need none of this. They run from a separate plugin that depends on no Hayba code (section 13.1), so they can start now.

---

## 4. Decisions this spec makes

| # | Decision | Reason |
|---|---|---|
| D-F1 | The new tools land **after** the removal of the four dead registrations, and the new wire commands do **not** reuse the dead wire names `fab_login_status`, `fab_library_list`, `fab_marketplace_search`, `fab_download`. None of the four appears in the satellite as a string literal either. | Those names mean "a command that never existed". A test asserts none of them is declared, called, in the sidecar, or a literal in the satellite (section 12.3) |
| D-F2 | Two tool names are reused on purpose, `hayba_fab_login_status` and `hayba_fab_library_list`, with new behaviour and new shapes. `hayba_fab_marketplace_search` and `hayba_fab_download` are not registered. | One name per capability. `hayba_fab_add_to_project` replaces the download tool; `hayba_fab_open` replaces search in Stage 1 |
| D-F3 | The core exports a small seam for satellites (section 5.6). The job registry header moves to `Public/` and the class is exported. | A satellite builds only against the core's public headers, and the registry is private and unexported today |
| D-F4 | Command policy stays in the core's central tables. A satellite does not declare its own access class or PIE rule. | P0 ruling R12: one read list. Anything not listed fails closed |
| D-F5 | `fab_library_sync` and `fab_open` are **not** added to the read sets. After P0 T8 they classify as `WriteScoped` without resources, and they are refused during PIE. | They start a network request or change the editor's UI. Failing closed costs little: neither is useful during PIE |
| D-F6 | The import job **holds** an exclusive lease on `asset:/Game/Fab` **from the first click evidence until it ends**. It holds nothing while it waits for the person. | P0 decision D5: work that writes assets marks itself busy by holding `asset:<path>`. Nothing is written before the click. A lease held while the person reads the licence would refuse every agent's `editor_start_pie` and `editor_save_all_and_quit`, and veto the person's Play button, for minutes |
| D-F7 | That lease is a **marker**. It does not cover assets below `/Game/Fab`. | Asset keys are flat: `asset:<path>` is its own node directly under `global` (`P/Private/HaybaMCPAccessPolicy.h:193-205`, `:209-218` `@leases`), and a conflict needs the same key (`:431-456` `@leases`) |
| D-F8 | The import start does **not** refuse when the session reads `not_signed_in`. It opens the Fab tab, adds the warning `session_not_signed_in`, and lets the person sign in on Fab's page as part of the hand-off. | A fresh editor always reads `not_signed_in` until a Fab tab opens (section 3.2). A refusal would fail the first call in every session |
| D-F9 | `fab_library_sync` **does** refuse with `fab_not_signed_in` unless the session reads `signed_in`, or reads `unknown` while a Fab tab is open. | Before the first tab opens, Fab's auth handle is unset, and the sync would pass it to EOS as it is (`F58/Private/Teds/FabMyFolderIntegration.cpp:45`) |
| D-F10 | Fab's log lines are never returned as text. Known lines map to event codes; everything else is counted. | `LogFab` can carry a whole server response (`FabMyFolderIntegration.cpp:166`) and a client id (`F58/Private/FabAuthentication.cpp:358`) |
| D-F11 | Hayba builds every Fab URL itself. Caller text never supplies the scheme, the host or the path. A `query` is percent-encoded into one parameter value, and a `query` with a control character is refused. | That browser has Fab's bridge bound to it, and the bridge exposes the credential getters to the page (section 3.2) |
| D-F12 | One running job per kind. One import watch and one library sync may run at the same time. Any caller may cancel any Fab job. | Registry changes cannot be attributed to one of two concurrent watches. The two kinds share no evidence. A job that nobody can cancel would hold its lease until its deadline |
| D-F13 | None of the eight commands is Plan-Mode gated or wrapped in an editor transaction. | Hayba mutates nothing. The person performs the import |
| D-F14 | The satellite does **not** depend on the `Fab` plugin and does **not** link the `Fab` module. Everything of Fab's is found by reflection path or by name, and feature-detected. | A dependency would turn Fab back on in a project that disabled it (section 3.1). The one exported function Hayba wanted only returns a settings property that reflection reads anyway (section 3.2) |
| D-F15 | **The click log line is the only way out of `waiting_for_user`.** Registry or cache activity without it changes no state. A heuristic exit exists only for a Fab version whose log lines no probe has confirmed. | Without it, another agent, a source-control sync or the person's own edit could move the job to `succeeded` with no import. Fab logs the click before any workflow runs, cached or not |
| D-F16 | `fab_import_watch_start` makes **no lease claim at the router**, and P0's `AssetWriteCommands` table is not changed. The job acquires its lease itself, through the satellite seam. | A row of that table maps a command to a param field that names an asset. This command has no such field. P0 parses declared `resources` only for `python_run`. Everything the lease is for (section 3.3) comes from the held lease, not from a claim on the command |
| D-F17 | The satellite keeps `EnabledByDefault: true` and lists `EOSShared` as a dependency. | It is the form of the other satellites, and a satellite is present only after someone copied it into the project. The cost is RK14: installing it enables `EOSShared` |
| D-F18 | The probes run from a separate plugin, `HaybaFabProbe`, on a branch that never merges. The satellite contains no probe code. | The probes then need neither P0 nor the toolkit, so their results arrive first. The satellite's command list stays exact, and no static check needs an exemption |
| D-F19 | Result arrays are paged, not cut. | A cut list cannot be saved by pathspec, which is the core contract |
| D-F20 | Section 8 is a hypothesis until the recordings exist. A probe may change a value of `FTuning`. A change to a state, a transition, an input or a result key is an amendment to this spec, committed before the code. | The machine was written from source reading. The recordings are the evidence |

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
      HaybaMCPFabHandler.h/.cpp    the eight commands: parse, preflight, shape. No engine Fab calls
      HaybaFabBackend.h            IHaybaFabBackend and its value types (section 12.1)
      HaybaFabPluginBackend.h/.cpp the production backend
      HaybaFabHostOps.h            the calls into the core's seam, as replaceable functions (section 12.1)
      HaybaFabContract.h/.cpp      feature detection (section 5.5)
      HaybaFabVerified.h           pure: what the probes confirmed, per Fab version (section 5.5)
      HaybaFabWatchPolicy.h        pure: FWatchMachine and FSyncMachine (sections 8 and 9)
      HaybaFabAttribution.h        pure: which change belongs to which listing (section 8.6)
      HaybaFabListing.h            pure: parse a listing, build and compare URLs (section 6.2)
      HaybaFabLogEvents.h          pure: map a LogFab line to an event code (section 11.7)
      HaybaFabScrub.h              pure: scrub token-shaped strings (section 11.6)
      HaybaFabTexts.h              pure: every fixed text of Appendix A
      HaybaFabJobs.h/.cpp          the two ticker pumps and the result store (sections 10.3 and 10.4)
      Tests/                       section 12.2
      Tests/Fixtures/              scrubbed probe recordings (section 13.1)
```

### 5.2 `.uplugin`

The same form as `HaybaMCPGAS.uplugin`, without a reference to the plugin it drives.

```json
{
  "FileVersion": 3,
  "Version": 1,
  "VersionName": "0.1.0",
  "FriendlyName": "Hayba MCP - Fab",
  "Description": "Optional Fab (fab_*) command satellite for HaybaMCPToolkit. It drives the engine's own Fab plugin and never handles credentials. It does not enable Fab: when Fab is disabled in the project, the satellite loads and its commands answer fab_unavailable.",
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
    { "Name": "EOSShared", "Enabled": true }
  ]
}
```

- `Fab` is **not** in the list (D-F14).
- `EOSShared` is in the list because the satellite links its module. Installing the satellite therefore enables `EOSShared`, also in a project that disabled Fab (RK14). In a project with Fab enabled nothing changes, because Fab needs `EOSShared` itself.
- Fab loads at `PostDefault` (`<engine>/Engine/Plugins/Fab/Fab.uplugin`, the `LoadingPhase` of its module), which is before `PostEngineInit`. When the satellite starts, Fab is either loaded or disabled.

### 5.3 Module dependencies

| Module | Why | Link or reflection |
|---|---|---|
| `HaybaMCPToolkit` | `IHaybaMCPHandler`, the router registration, the satellite seam, the job registry | link, public headers only |
| `Core`, `CoreUObject`, `Engine`, `UnrealEd` | reflection, `GEditor` for the PIE check | link |
| `Json`, `JsonUtilities` | shapes | link |
| `AssetRegistry` | registry change delegates, package state, `IsLoadingAssets` | link |
| `InterchangeEngine` | `UInterchangeManager::IsInterchangeActive` and the three import delegates | link |
| `Slate`, `SlateCore`, `ToolMenus`, `LevelEditor` | find or open the Fab tab | link |
| `WebBrowser` | `SWebBrowser::LoadURL` and `GetUrl` (`<engine>/Engine/Source/Runtime/WebBrowser/Public/SWebBrowser.h`) | link |
| `Projects` | `IPluginManager` for plugin state and version | link |
| `EOSShared`, `EOSSDK` | `IEOSSDKManager::GetActivePlatforms`, account counts | link |
| `TypedElementFramework` | `ICoreProvider`, the URL and web-image columns | link |
| Fab settings (cache folder, quality tier, environment, experience mode), local assets, library columns, console command, tab entry points | | reflection path or name lookup, feature-detected |

### 5.4 Source hygiene

- Include no Fab header, public or private. The `Fab` module is not on the include path, and that is the point.
- Ask `FModuleManager::Get().IsModuleLoaded("Fab")` to learn whether Fab runs.
- Do not subclass `IFabWorkflow`. Its base class differs between 5.7 and 5.8 (section 14).
- The identifiers in section 11.2 never appear in the satellite's source. A Node test scans for them.
- The only `EOS_` functions in the source are the four of section 6.1.

### 5.5 Feature detection

`FHaybaFabContract::Probe()` runs on the first Fab command and on every `fab_status`. It reads names and shapes. It never reads a value that could be a credential.

"Refuse" means the command answers `fab_contract_changed` with `missing: ["<item>", …]`. "Degrade" means the command runs and adds the warning `fab_contract_changed` with the same list.

| Contract item | What is checked | Needed by | When it is missing |
|---|---|---|---|
| `fab_module` | module `Fab` is loaded | everything but `fab_status` and the two job commands | refuse with `fab_unavailable`, reason `fab_disabled` |
| `fab_version` | `IPluginManager` finds plugin `Fab` with a version name | `fab_status` | degrade: `fab_version: null` |
| `settings_class` | class `/Script/Fab.FabSettings` exists | the next four | as for each of them |
| `quality_tier_property` | enum property `PreferredQualityTier` | the `quality_tier_raw` warning | degrade: `quality_tier: null`, no tier warning |
| `cache_directory_property` | struct property `CacheDirectoryPath` | cache measurement | degrade: `cache_measured: false` |
| `environment_property` | enum property `Environment` | `fab_open`, `fab_import_watch_start` | refuse: Hayba cannot tell whether Fab is on production |
| `experience_mode_property` | 5.8: enum property `ExperienceMode` | `fab_status.experience_mode` | degrade: `experience_mode: null` |
| `local_assets_class` | class `/Script/Fab.FabLocalAssets` with map property `PathsListingID` | attribution, `in_project`, `fab_import_describe` | the import watch degrades: no `fab_recorded` attribution. `fab_library_read` degrades: `in_project.join` stays `unverified`. `fab_import_describe` refuses |
| `library_columns` | structs `/Script/Fab.FabObjectColumn` (with `AssetId`, `AssetNamespace`, `ListingType`, `Seller`, `Source`) and `/Script/Fab.FabObjectNameColumn` (with `Name`) | the two library commands | refuse |
| `library_sync_command` | console object `Fab.TEDS.MyFolderIntegration` is registered | `fab_library_sync` | refuse |
| `data_storage` | the editor data storage feature is available | the two library commands | refuse |
| `eos_manager` | `IEOSSDKManager::Get()` is non-null and initialized | the session | degrade: `session: "unknown"` |
| `tab_entry_point` | 5.7: tab spawner `FabTab` is registered. 5.8: tool-menu entry `OpenFabTab` exists in `MainFrame.MainMenu.Window` | opening a tab | degrade: an open tab is still used; otherwise the system browser |
| `browser_widget` | checked lazily: the resolved Fab tab contains an `SWebBrowser` | in-editor navigation | degrade: the system browser |
| `log_events_verified` | the Fab plugin's version is in `HaybaFabVerified.h` with its click line confirmed | the import watch | degrade: the heuristic exit of section 8.5, and the warning `click_not_observed` |

`HaybaFabVerified.h` is a constant table keyed by Fab plugin version. Each row says whether the click line was confirmed, whether the id in that line equals the listing id, and which import kinds were verified. The probes fill it (section 13.3). Before any probe it is empty.

Reporting:

- `fab_status.contract` is `{ "ok": bool, "fab_contract_changed": ["<item>", …] }`.
- One smoke test runs the real probe on the engine under test and expects an empty list apart from `log_events_verified` (section 12.2). It needs no sign-in and no network.

### 5.6 Core companion changes

These are changes to `HaybaMCPToolkit`. They are plan 1 (section 16.2) and land before the satellite.

| # | Change | File |
|---|---|---|
| C1 | Move the job registry header to `P/Public/HaybaMCPJobRegistry.h`, export the class, and extend it (section 10). | `P/Public/HaybaMCPJobRegistry.h`, `P/Private/HaybaMCPJobRegistry.cpp`, `handlers/HaybaMCPBuildHandler.cpp` |
| C2 | New public header `P/Public/HaybaMCPSatelliteHost.h`, namespace `HaybaMCPSatelliteHost`, every function exported. | new |
| C3 | Add five Fab commands to the shared command sets (section 6.0), add `SatelliteCommands()`, move every size pin, and teach the drift tests about satellite commands. `AssetWriteCommands` is not touched. | `P/Private/HaybaMCPCommandSets.h`, the C++ drift tests, and the Node drift tests `access-policy-drift.test.ts`, `editor-state-policy-drift.test.ts`, `editor-health-contract.test.ts`, `asset-busy-drift.test.ts`, `ue-refusal-codes.test.ts` |
| C4 | Add the Fab refusal codes to `IsWireRefusalCode`. | `P/Private/HaybaMCPCommandHandler.cpp` |
| C5 | Add an `eg1~` pattern to both redaction layers. | `P/Private/HaybaMCPSecretRedaction.cpp`, `N/src/security/secret-redaction.ts` |
| C6 | `editor_run_console_command` refuses six console commands with code `console_command_refused` (rule below). | `P/Private/handlers/HaybaMCPEditorHandler.cpp:464-479` has no check today |
| C7 | `editor_get_output_log` and `editor_stream_log` drop the lines of two log categories and the lines of one function family (rule below), and report `dropped_lines`. | `P/Private/handlers/HaybaMCPEditorHandler.cpp:482-510`, `:596-625` return raw lines today |

C6 and C7 change two existing tools for every user. They get their own changelog entry.

**The C6 rule.**

1. Split the command string at every `|`.
2. Trim each segment and take its first word.
3. Compare that word without regard to case with: `EOSSDK`, `Fab.Login`, `Fab.Logout`, `Fab.SetEnvironment`, `Fab.ClearCache`, `Fab.TEDS.MyFolderIntegration`.
4. If any segment matches, refuse the whole string.

- The library sync is reachable only through `fab_library_sync`, which has the preflight and the rate limit.
- **C6 guards `editor_run_console_command` only.** `python_run` can run console commands and is not covered. C6 is a guard against accidents, not a guarantee. C7 and the redaction layers are what stand behind it.

**The C7 rule.** A line is dropped when any of these holds:

- its category is `LogEOSShared`;
- its category is `LogEOSSDK`;
- it contains `FEOSSDKManager::Log` or `FEOSPlatformHandle::Log`.

The test uses a line in the engine's real format, `LogEOSShared: FEOSSDKManager::LogAuthInfo   AccessToken=eg1~…`, and asserts that the line is **absent** from the reply, not masked.

**The seam C2** contains exactly this:

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

    /** True when an owner other than ExcludeOwner holds an exclusive lock on this asset key. Reads only. */
    bool FindAssetLeaseHolder(const FString& AssetResource, const FString& ExcludeOwner, FString& OutHolderOwner);

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
- The lease lifetime is clamped by the lease table to at most 900 s (`P/Private/HaybaMCPLeasePolicy.h:39` `@leases`).
- C1 changes a class layout. It needs a full rebuild with the editor closed; Live Coding cannot apply it.

**Drift tests and satellites (C3).**

- The P0 drift tests require every listed name to be a registered command. A satellite's commands are unregistered whenever the satellite is not installed.
- `HaybaMCPCommandSets.h` therefore gains `SatelliteCommands()`, a map from command name to satellite module name. A drift test accepts a listed satellite command when it is registered, **or** when its satellite module is not loaded.
- That rule alone would accept a misspelt module name for ever. A Node test therefore asserts that every module name in `SatelliteCommands()` is a module of a `.uplugin` under `unreal/` (section 12.3).
- P0 pins the size of every set, and moves those pins during its own tasks. This spec gives no absolute numbers. The Fab change adds two names to `StatusOnlyCommands()`, the same two to `ControlPlaneCommands()`, and three to `ReadCommands()`. Every pin, in C++ and in the Node drift tests, moves by that amount in the same commit.

---

## 6. Wire commands

Handler domain: `fab`. Handler class: `FHaybaMCPFabHandler`.

### 6.0 Common rules

**Classification.** "Default" means the command is listed nowhere, so P0's fail-closed rules apply.

| Command | Access class after P0 T8 | Listed in | During PIE | While `editor_unsafe` | Node retry on transport failure |
|---|---|---|---|---|---|
| `fab_status` | Read | `ReadCommands()` | allowed | refused | allowed |
| `fab_open` | WriteScoped, no resources | nowhere (default) | `pie_active` | refused | allowed |
| `fab_import_watch_start` | WriteScoped, no resources | nowhere (default) | `pie_active` | refused | never (`NON_IDEMPOTENT`) |
| `fab_import_describe` | Read | `ReadCommands()` | allowed | refused | allowed |
| `fab_job_status` | Read | `StatusOnlyCommands()` **and** `ControlPlaneCommands()` | allowed | allowed | allowed |
| `fab_job_cancel` | Read | `StatusOnlyCommands()` **and** `ControlPlaneCommands()` | allowed | allowed | allowed |
| `fab_library_sync` | WriteScoped, no resources | nowhere (default) | `pie_active` | refused | never (`NON_IDEMPOTENT`) |
| `fab_library_read` | Read | `ReadCommands()` | allowed | refused | allowed |

- The two job commands are in both sets because P0 requires every status command to be a control-plane command or a read, and because only the read sets make a command a Read after T8. Listed in the status set alone, they would classify as writes, and a status poll would be refused during PIE.
- The two job commands qualify for `StatusOnlyCommands()` because they touch only the job registry and the satellite's result store. They never resolve a `UObject`.
- `fab_status`, `fab_import_describe` and `fab_library_read` are not in P0's `UnsafeReads`, so the unsafe gate refuses them.
- A WriteScoped command without resources takes only intent locks on the world and on `global` (`P/Private/HaybaMCPAccessPolicy.h:470` `@leases`). It collides with another owner that holds the world or everything exclusively, and with nothing else.
- No Fab command makes an asset claim at the router (D-F16).
- None of the eight is in `IsDestructiveCommand` (`P/Private/HaybaMCPCommandHandler.cpp:399`). D-F13.

**Gate order.** The router's gates run first, in the P0 order: auth, `editor_unsafe_restart_required`, `pie_active`, `asset_busy`, the lease gate. The handler's own preflight runs after them. The handler repeats none of them, and it emits none of the router's codes.

**Refusal channel.** A handler refusal is `Ok(Data{ok:false, code, error, phase:"preflight", mutation_status:"not_started", …detail})`. The router promotes `data.code` to the envelope's top-level `code` (P0 T5, `IsWireRefusalCode`). The data object of every Fab refusal has this form:

```jsonc
{
  "ok": false,
  "code": "fab_unavailable",                 // one of the handler codes in section 15.1
  "error": "fab_unavailable: 'fab_open' was not run: the editor's web browser cannot start, so Fab's tab cannot show a page.",
  "phase": "preflight",
  "mutation_status": "not_started",
  "command": "fab_open",
  "reason": "web_browser_unavailable",
  "hint": "Enable the Web Browser plugin (Edit > Plugins), restart the editor, then call again."
  // plus the detail keys listed per code in section 15.1
}
```

**One error shape.** Wherever a reply carries an `error` object or a `sync_error` object, it is `{ "code", "reason", "message" }`. `reason` is `null` when the code has no reasons. `message` is the text of Appendix A.8.

**The `error` string of a refusal** is built as `<code>: '<command>' was not run: <cause>`, with the cause of Appendix A.2 or A.3.

**Key and text rules.** They keep both redaction layers from mangling a reply.

- No key ends in a secret word: token, secret, password, passwd, pwd, credential, cookie, authorization, or a `*key` compound. This is the P0 T4 rule, applied to the Fab protocol.
- No fixed text contains one of those words followed by `:` or `=`. Every fixed text is in Appendix A.
- No key and no string literal in the satellite equals one of the four dead wire names (D-F1).
- Ids are lower-case and have hyphens, in groups of 8, 4, 4, 4 and 12 hex digits. A job id is the registry's GUID, in the form the registry gives it (`P/Private/HaybaMCPJobRegistry.cpp:14`), and is compared without regard to case.
- Small arrays are bounded: at most 20 read-only files and 32 warnings. **The result arrays of a job are paged, not cut** (section 6.5).

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
  "last_open": {                     // the latest fab_open or import start; null when there was none
    "target": "listing",             // "listing" | "search" | "home"
    "via": "fab_tab",
    "navigation": "confirmed",       // "requested" | "pending" | "confirmed" | "failed" | "not_attempted"
    "at": "2026-09-28T10:00:00Z"
  },
  "quality_tier": "medium",          // "low" | "medium" | "high" | "raw" | null
  "experience_mode": "standard",     // 5.8 only: "standard" | "performance"; null on 5.7
  "cache_bytes": 734003200,          // size of Fab's whole cache folder at the last measurement; null when none has finished
  "cache_measured_at": "2026-09-28T09:59:30Z",
  "contract": { "ok": true, "fab_contract_changed": [] },
  "active_jobs": [ { "job_id": "…", "kind": "import_watch", "status": "waiting_for_user" } ],
  "hint": "Fab signs in when its tab opens. Open Window > Fab, or call hayba_fab_open."
}
```

- `cache_bytes` describes a folder that every project and every engine on the machine shares (section 3.2). It is measured on the thread pool (section 10.3). A `fab_status` call returns the last finished value and starts a new measurement when the last one is older than 60 s.
- The reply has no field about Fab's web service. Hayba calls none.

**How the session is decided.** No Fab symbol is used and no credential is read.

1. On the game thread, take `IEOSSDKManager::Get()->GetActivePlatforms()`.
2. Keep the platforms whose `GetConfigName()` is empty. Fab's platform is one of them (section 3.2).
3. For each, take the auth interface with `EOS_Platform_GetAuthInterface`, the count with `EOS_Auth_GetLoggedInAccountsCount`, each account with `EOS_Auth_GetLoggedInAccountByIndex`, and its state with `EOS_Auth_GetLoginStatus`.
4. Decide:

| Unnamed platforms | Result |
|---|---|
| none | `unknown` |
| every one has at least one signed-in account | `signed_in` |
| none has a signed-in account | `not_signed_in` |
| they disagree | `unknown`. It is never a guess |

**The EOS allowlist is closed.** Those four functions are the only `EOS_` functions in the satellite. An account id is passed to `EOS_Auth_GetLoginStatus` and to nothing else. It is never converted to text, logged, stored or returned. The source scan asserts that no other `EOS_Auth_` symbol and no `EOS_EpicAccountId_ToString` appears (section 11.2).

`reason_unavailable` values:

| Value | Condition |
|---|---|
| `fab_disabled` | the `Fab` module is not loaded, because the project disabled the Fab plugin |
| `emporium` | the `Emporium` plugin is enabled (5.8: Fab skips its own start-up) |
| `commandlet` | the process is a commandlet. Fab does not start there (`F58/Private/FabModule.cpp:51`) |
| `web_browser_unavailable` | the web browser module cannot create a browser |
| `non_production_environment` | Fab's `Environment` setting is not production |

Refusals from the handler: `fab_bad_request` (any param). Otherwise it always answers when the satellite is loaded.
Refusals from the router: `editor_unsafe_restart_required`.

### 6.2 `fab_open`

Params: `{ "listing"?: string, "query"?: string (1..200 characters), "free_only"?: boolean }`.

- At most one of `listing` and `query`. With neither, Fab's home is shown.
- `free_only` without `query` is refused with `fab_bad_request`.
- A `query` that contains a control character is refused with `fab_bad_request`.

**Listing parsing (pure, `HaybaFabListing.h`).** `listing` is an id or a URL.

- An id matches `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` after lower-casing.
- A URL must be `https`, its host must be exactly `fab.com` or `www.fab.com`, and its path must be `/listings/<id>` or `/plugins/ue5/listings/<id>`. A query string or fragment is dropped.
- Anything else is refused with `fab_invalid_listing`. The caller's text is never loaded.
- Probe P10 records the form of the URLs in Fab's library feed. If that form is not one of the two above, the parser is amended (D-F20).

**URL building.** Hayba builds the URL itself, in the form Fab's own "View in Fab" uses.

| | 5.7 | 5.8 |
|---|---|---|
| Base | `https://www.fab.com` | `https://fab.com` |
| Listing, in Fab's tab | `<base>/plugins/ue5/listings/<id>` | same |
| Search, in Fab's tab | `<base>/plugins/ue5/search?q=<percent-encoded query>` plus `&is_free=1` when `free_only` | same |
| Home, in Fab's tab | `<base>/plugins/ue5` | same |
| Listing, in the system browser | `<base>/listings/<id>` | same |
| Search, in the system browser | `<base>/search?q=<percent-encoded query>` plus `&is_free=1` | same |
| Home, in the system browser | `<base>` | same |

The `/plugins/ue5/…` pages expect Fab's bridge, which an ordinary browser does not have. The system browser therefore gets the public form.

**URL comparison (pure).** Hayba reads the browser's current URL for two questions only: "has the tab left the local index page?" and "does the tab show the URL I built?".

- The URL is parsed. The host is compared **exactly** with `fab.com` and `www.fab.com`. A prefix test is not enough: `https://fab.com.example` starts with `https://fab.com`.
- The path is compared after an optional leading `/plugins/ue5` is removed. The query string is ignored.
- The browser's URL is used for that comparison and for nothing else. It is never stored, logged or returned.

**Resolving the tab.** The tab is resolved once per job or per command, and then kept.

1. Look for a live Fab tab.
   - 5.7: `FGlobalTabmanager::FindExistingLiveTab("FabTab")`.
   - 5.8: look for `Fab1` … `Fab64` in the global tab manager. If none is found, walk the visible windows for an `SWebBrowser` whose URL has a Fab host or is Fab's local index page.
2. If there is none, open one.
   - 5.7: `TryInvokeTab("FabTab")`. Before that, check that the web browser module can create a browser, and wrap the call in `TGuardValue<bool>(GIsRunningUnattendedScript, true)`: without a browser, 5.7 raises a modal (`F57/Private/FabBrowser.cpp:284-289`).
   - 5.8: run the tool-menu entry `OpenFabTab`. It creates a **new** tab on every run (`F58/Private/FabBrowser.cpp:134-144`, `:335-382`), so Hayba runs it only when no live Fab tab exists. Around that call Hayba listens to the global tab manager's tab-foregrounded and active-tab-changed delegates and takes the first new tab whose content holds an `SWebBrowser`.
3. Keep a `TWeakPtr<SDockTab>` and a `TWeakPtr<SWebBrowser>` for that tab.
   - **The tab is alive while the weak pointer is valid.** A tab in the background, or a tab that Fab's own tab manager holds, stays alive although its content is not in the visible widget tree.
   - Hayba resolves again only when the pointer is invalid, and at most once a second.
   - A job follows the tab it navigated, not "any Fab tab".

**Navigating.**

1. **Wait until the tab is ready.** A created tab first shows Fab's local index page, which redirects to Fab's home by itself. A `LoadURL` sent before that redirect would be overwritten by it. Hayba waits until the browser's URL has left the local page and has a Fab host. An existing tab that already shows a Fab page is ready at once.
2. **Request.** Call `LoadURL` with the built URL. `navigation` is `requested`.
3. **Confirm.** On later ticks, compare the browser's URL with the built one. When they match, `navigation` is `confirmed`.
4. **Give up.** If the tab is not ready, or the URL is not confirmed, within 20 s: `navigation` is `failed`, and the system browser opens the public form with `via: "system_browser"`.
5. If no tab can be opened at all, the system browser opens the public form at once and `navigation` is `not_attempted`.

`fab_open` returns at once. Its reply carries the state at that moment: `requested`, `pending` (the tab is not ready yet) or `not_attempted`. A one-shot ticker finishes the steps. The final state is in `fab_status.last_open`.

```jsonc
{
  "opened": true,
  "via": "fab_tab",                  // "fab_tab" | "system_browser"
  "tab": "existing",                 // "existing" | "created" | null
  "navigation": "requested",         // "requested" | "pending" | "not_attempted"
  "url": "https://fab.com/plugins/ue5/listings/0a1b2c3d-…",
  "results": null,                   // always null: this command returns no search data
  "warnings": []
}
```

**While an import watch waits.** When an import watch is in `opening` or `waiting_for_user`, `fab_open` is refused with `fab_job_already_running` and `active_job_id`, unless it names the listing of that watch. Otherwise any agent could move the tab away while the person reads the licence.

Refusals from the handler: `fab_bad_request`, `fab_invalid_listing`, `fab_unavailable`, `fab_contract_changed` (missing `environment_property`), `fab_job_already_running`.
Refusals from the router: `editor_unsafe_restart_required`, `pie_active`, `lease_conflict`, `owner_required`.

### 6.3 `fab_import_watch_start`

Params:

| Param | Type | Default | Meaning |
|---|---|---|---|
| `listing` | string, required | | an id or a Fab listing URL (section 6.2) |
| `click_timeout_s` | integer 30..900 | 300 | how long the job waits for the click, from the start |
| `timeout_s` | integer 60..3600 | 900 | how long the job waits for the import to settle, **from the first click evidence** |
| `size_warn_bytes` | 64-bit integer ≥ 1048576 | 2147483648 | the threshold of the one size warning |

The person's reading time counts against `click_timeout_s` only. It never shortens the time left for the download.

These params are refused by name, so an agent with a stale memory of the dead tools gets a clear answer:

| Param | Code |
|---|---|
| `target_path`, `target_dir` | `fab_target_path_unsupported`. Fab decides where content lands (section 3.2) |
| `accept_licence`, `accept_license`, `accept_eula` | `fab_licence_acceptance_unsupported`. Only the person accepts a licence |
| `download_url`, `asset_id`, any other unknown key | `fab_bad_request` |

Preflight, in order. A refusal stops; a warning continues.

| # | Check | Result |
|---|---|---|
| 1 | params | `fab_bad_request`, `fab_target_path_unsupported`, `fab_licence_acceptance_unsupported`, `fab_invalid_listing` |
| 2 | Fab is available | `fab_unavailable` with `reason` |
| 3 | `IAssetRegistry::IsLoadingAssets()` is true | `fab_unavailable`, reason `asset_registry_loading`. While the registry loads, it reports every existing asset as added |
| 4 | another import watch is running, whoever owns it | `fab_job_already_running` with `active_job_id` |
| 5 | contract items | `fab_contract_changed` when `environment_property` is missing; otherwise the warning (section 5.5) |
| 6 | session is `not_signed_in` | warning `session_not_signed_in` (D-F8) |
| 7 | read-only files under `Content/Fab`, at most 2000 files examined | warning `read_only_files` with up to 20 paths and the source-control provider's name |
| 8 | quality tier is `raw` | warning `quality_tier_raw` |
| 9 | 5.8 and `Content/Fab/Materials` does not exist | warning `megascans_parent_materials_will_be_saved` |
| 10 | another owner holds `asset:/Game/Fab` | warning `lease_held_by_other` with the holder's owner |

- The handler does not ask about PIE. The router has refused by then.
- The handler acquires no lease. The pump does, at the first click evidence (section 10.3).
- Check 10 never refuses. The watch writes nothing, and the person can click whether Hayba watches or not. A refusal would only remove the report.

Then the handler snapshots the state it compares against (Fab's recorded ids, the top-level `/Game` folders), allocates the job, starts the captures (the `LogFab` capture, the registry delegates, the Interchange delegates), starts the navigation of section 6.2, and returns.

```jsonc
{
  "job_id": "…",
  "kind": "import_watch",
  "status": "opening",               // or "waiting_for_user" when the navigation needed no wait
  "terminal": false,
  "listing_id": "0a1b2c3d-…",
  "listing_url": "https://fab.com/plugins/ue5/listings/0a1b2c3d-…",
  "opened": { "via": "fab_tab", "tab": "existing", "navigation": "requested" },
  "user_action": "In the Fab tab: sign in if the page asks, read the licence, then click Add to Project. Keep the Fab tab open until the import finishes.",
  "click_timeout_s": 300,
  "timeout_s": 900,
  "size_warn_bytes": 2147483648,
  "preflight": {
    "quality_tier": "medium",
    "read_only_count": 0,
    "read_only_files": [],
    "source_control": "None",
    "parent_materials": "will_be_copied_and_saved"   // "present" | "will_be_copied_and_saved" | "not_applicable"
  },
  "imported_paths": [],              // core contract: present from the first reply
  "unsaved_packages": [],            // core contract: present from the first reply
  "saved_by_fab": [],
  "evaluated": false,
  "warnings": [ { "code": "megascans_parent_materials_will_be_saved", "message": <Appendix A.1> } ],
  "poll": { "command": "fab_job_status", "after_s": 2 }
}
```

- `parent_materials` is `not_applicable` on 5.7.
- When the listing had to go to the system browser, `user_action` is the second text of Appendix A.5.
- Node replaces `poll.command` with the tool name before the agent sees it (section 7.0).

Refusals from the router: `editor_unsafe_restart_required`, `pie_active`, `lease_conflict`, `owner_required`.

### 6.4 `fab_import_describe`

Params: `{ "listing": string, "offset"?: integer ≥ 0 default 0, "limit"?: integer 0..500 default 200 }`.

It answers from two sources: Fab's record of the listing (section 11.5) and the asset registry. It starts no job and watches nothing.

```jsonc
{
  "listing_id": "0a1b2c3d-…",
  "recorded": true,                  // false when Fab's record has no folder for this id
  "fab_location": "/Game/Fab/Megascans/3D/Rock_abc",
  "attribution": "fab_recorded",     // null when recorded is false
  "counts": { "imported": 12 },      // every package under fab_location now
  "offset": 0, "limit": 200, "has_more": false,
  "imported_roots": ["/Game/Fab/Megascans/3D/Rock_abc"],
  "imported_paths": ["/Game/Fab/Megascans/3D/Rock_abc/High/SM_Rock"],   // this page, sorted
  "unsaved_packages": ["/Game/Fab/Megascans/3D/Rock_abc/High/SM_Rock"], // the dirty or not-on-disk part of this page
  "saved_packages": [],              // the rest of this page
  "evaluated": true,
  "evaluated_at": "2026-09-28T10:05:00Z",
  "warnings": [],
  "next": "Save only the packages you choose from unsaved_packages. Hayba saved nothing."
}
```

Rules:

- `imported_paths` here is **every package under the recorded folder now**, not what one import changed. A later edit by the person is in it.
- The partition is computed for the returned page only, so one call examines at most 500 packages. The caller pages with `offset`.
- It covers the recorded folder only. It does not list `/Game/Fab/Materials`. A MetaHuman has no record, and a pack's record can be missing (section 3.2); both answer `recorded: false`.
- It depends on V5: that the id Fab records is the listing id.
- When `recorded` is false, the three arrays are empty, `evaluated` is false, and the hint is the text of Appendix A.4.

Refusals from the handler: `fab_bad_request`, `fab_invalid_listing`, `fab_unavailable` (also with reason `asset_registry_loading`), `fab_contract_changed` (missing `local_assets_class`).
Refusals from the router: `editor_unsafe_restart_required`.

### 6.5 `fab_job_status`

Params: `{ "job_id": string, "offset"?: integer ≥ 0 default 0, "limit"?: integer 0..500 default 200 }`.

For `kind: "import_watch"`:

```jsonc
{
  "job_id": "…",
  "kind": "import_watch",
  "status": "succeeded",             // "opening" | "waiting_for_user" | "downloading" | "importing"
                                     // | "succeeded" | "failed" | "cancelled" | "timed_out" | "abandoned"
  "terminal": true,                  // true only when the registry says Done
  "phase": "done",                   // "opening" | "waiting_for_click" | "download_observed" | "import_observed"
                                     // | "settling" | "finalizing" | "done"
  "listing_id": "0a1b2c3d-…",
  "listing_url": "https://fab.com/plugins/ue5/listings/0a1b2c3d-…",
  "listing_type": "gltf",            // "unreal-engine" | "gltf" | "glb" | "fbx" | "metahuman" | "other"; null before the click
  "import_kind": "megascans_3d",     // "gltf_fbx" | "megascans_3d" | "megascans_surface" | "ue_pack" | "plugin" | "metahuman" | "unknown"
  "started_at": "2026-09-28T10:00:00Z",
  "clicked_at": "2026-09-28T10:00:41Z",           // null before the click
  "finished_at": "2026-09-28T10:01:24Z",          // null while running
  "elapsed_s": 84.2,
  "stalled_s": 0.0,                  // time the game thread was blocked; it does not count against a deadline
  "click_timeout_s": 300,
  "timeout_s": 900,
  "timed_out_waiting_for": null,     // "click" | "import" when status is "timed_out"
  "cancel_requested": false,
  "cancel_reason": null,             // "caller" | "fab_notification" when status is "cancelled"
  "cancelled_by": null,              // the owner that cancelled
  "opened": { "via": "fab_tab", "tab": "existing", "navigation": "confirmed" },
  "observed": {
    "click_events": 1,
    "cache_growth_bytes": 734003200, // peak growth of <cache>/<listing id> since the click; includes unpacked archives
    "cache_measured": true,
    "registry_changes": 14,
    "changes_before_click": 0,
    "interchange_active": false,
    "log_events": ["add_to_project", "listing_type", "parent_materials_copy_started"],
    "unrecognised_log_lines": 3,
    "unrecognised_error_lines": 0
  },
  "size_warning": null,              // or { "threshold_bytes": 2147483648, "observed_bytes": 2147999999, "at_s": 61.0, "message": <Appendix A.1> }
  "attribution": "fab_recorded",     // "fab_recorded" | "pack_rule" | "metahuman_rule" | "unconfirmed" | null while running
  "listing_match": "true",           // "true" | "false" | "unknown"
  "fab_listing_id": "0a1b2c3d-…",    // the id in Fab's click line for the primary listing, or null
  "fab_location": "/Game/Fab/Megascans/3D/Rock_abc",       // the folder Fab recorded for it, or null
  "other_listings": [],              // [{ "listing_id", "outcome": "recorded" | "pending", "fab_location", "imported_count" }]
  "counts": { "imported": 3, "assets": 3, "unsaved": 1, "saved_by_fab": 2, "unattributed": 0 },
  "offset": 0, "limit": 200, "has_more": false,
  "imported_roots": ["/Game/Fab/Megascans/3D/Rock_abc", "/Game/Fab/Materials"],   // never paged, never cut
  "imported_paths": ["/Game/Fab/Materials/Standard/M_MS_Base", "…"],     // package names, sorted, no duplicates
  "imported_assets": [
    { "path": "/Game/Fab/Megascans/3D/Rock_abc/High/SM_Rock.SM_Rock",
      "package": "/Game/Fab/Megascans/3D/Rock_abc/High/SM_Rock",
      "class": "StaticMesh", "change": "added" }           // "added" | "updated"
  ],
  "unsaved_packages": ["/Game/Fab/Megascans/3D/Rock_abc/High/SM_Rock"],
  "saved_by_fab": ["/Game/Fab/Materials/Standard/M_MS_Base", "…"],
  "unattributed_changes": [],
  "evaluated": true,
  "evaluated_at": "2026-09-28T10:01:24Z",         // null when evaluated is false
  "paths_capped": false,
  "arrays_expired": false,
  "pie_started_during_job": false,
  "lease": { "held": false, "resource": "asset:/Game/Fab" },
  "warnings": [],
  "error": null,                     // or { "code": "fab_download_failed", "reason": null, "message": "Fab reported that the download failed." }
  "next": "Save only the packages you choose from unsaved_packages. Hayba saved nothing."
}
```

Definitions:

| Key | Meaning |
|---|---|
| `imported_paths` | Package names of the assets that were added or updated **by the import of the primary listing**, as far as the attribution can tell (section 8.6). **Core contract** |
| `unsaved_packages` | The subset of `imported_paths` whose package is dirty, or has no file on disk, at `evaluated_at`. **Core contract. This is the list to save by** |
| `saved_by_fab` | The subset that already has a file on disk and is not dirty. When `evaluated` is true, `imported_paths` is the disjoint union of `unsaved_packages` and `saved_by_fab` |
| `unattributed_changes` | Packages that changed under `/Game` after the click and belong to no tracked listing. They are never in `imported_paths` |
| `imported_roots` | The smallest set of folders that contains every imported path. **For information.** Saving by it would also save older dirty packages in those folders |
| `other_listings` | Listings the person added during the watch, other than the primary one. Their paths are not in any array; `hayba_fab_import_describe` lists them |
| `evaluated`, `evaluated_at` | Whether and when the two subsets were computed. The result is a snapshot: a later save does not change it. When `evaluated` is false, the two subsets are empty **because they were not computed** |
| `attribution` | Why the job believes the changes belong to a Fab import (section 8.5) |
| `listing_match` | Whether the id in Fab's click line equals the requested listing. `unknown` until `HaybaFabVerified.h` says that the id in that line is the listing id (V5) |
| `counts` | The full sizes of the five paged arrays |

**Paging.** Each of `imported_paths`, `imported_assets`, `unsaved_packages`, `saved_by_fab` and `unattributed_changes` is returned as the slice `[offset, offset + limit)` of its sorted full list. `has_more` is true when any of them has entries beyond the slice. To save everything, the caller pages until `offset` reaches `counts.unsaved`.

**Limits of the lists.**

- The driver keeps at most 65536 package names per job. Beyond that, `paths_capped` is true and the warning `paths_capped` is added. `counts` and `imported_roots` stay complete. Saving by `imported_roots` is then the only way left, and it also saves older dirty packages in those folders.
- The satellite keeps the full lists of the last eight finished import jobs (section 10.4). For an older job `arrays_expired` is true, the arrays are empty, and `counts` and `imported_roots` are still there.

The two core keys and `saved_by_fab` are present and are arrays in every reply, from the start reply on. They are empty until the job knows better.

For `kind: "library_sync"`:

```jsonc
{
  "job_id": "…", "kind": "library_sync",
  "status": "succeeded",             // "running" | "succeeded" | "failed" | "cancelled" | "timed_out"
  "terminal": true,
  "started_at": "…", "finished_at": "…", "elapsed_s": 4.1, "stalled_s": 0.0,
  "batch": 1000,
  "complete": "assumed",             // "end_of_list" | "assumed" | null (section 9)
  "observed": { "rows": 405, "pages_parsed": 1, "log_events": ["response_received", "page_parsed"],
                "unrecognised_log_lines": 0, "unrecognised_error_lines": 0 },
  "cancel_requested": false, "cancelled_by": null,
  "warnings": [],
  "error": null                      // or { "code": "fab_library_sync_failed", "reason": "request_failed_or_not_json", "message": <Appendix A.8> }
}
```

Refusals from the handler: `fab_bad_request`, `fab_job_unknown` (unknown id, or an id that is not a Fab job). After an editor restart every earlier id is unknown, because the registry lives in memory. The hint then names `hayba_fab_import_describe`.

### 6.6 `fab_job_cancel`

Params: `{ "job_id": string }`.

```jsonc
{
  "job_id": "…",
  "cancelled": true,
  "effect": "stopped_watching",
  "download_cancelled": false,
  "cancelled_by": "agent-a",
  "note": "Hayba stopped watching. Fab's own download or import continues; cancel it from Fab's notification."
}
```

- The command sets the registry's cancel flag. The pump sees it on its next tick, finalizes what it has, releases the lease and finishes the job as `cancelled`.
- **Any caller may cancel** (D-F12). When the caller is not the owner that started the job, the core logs a Warning that names both owners, as P0 does for stopping another owner's PIE. `cancelled_by` is in the reply and in the job's status.
- Cancelling a job that is already terminal is not an error: `{ "cancelled": false, "status": "<terminal status>", "note": "The job had already finished." }`.
- Fab's request queue is private, so Hayba cannot cancel the download (section 3.2).

Refusals from the handler: `fab_bad_request`, `fab_job_unknown`.

### 6.7 `fab_library_sync`

Params: `{ "batch"?: integer 1..1000, default 1000 }`.

What it does:

1. Preflight, in the order of the refusal list below.
2. If the previous sync ended `succeeded`, snapshot the current rows in memory as the last good list (at most 5000 rows; beyond that the warning `snapshot_truncated`). After a sync that did not succeed, the rows are partial or empty, and the earlier snapshot is kept.
3. Allocate a job with `OpName` `fab_library_sync`, and start a log capture for `LogFab`.
4. Run Fab's own console command `Fab.TEDS.MyFolderIntegration <batch>` through `IConsoleManager`. The generic console tool is not used. Fab makes its own request with its own credential.
5. Return at once. The pump drives the sync machine (section 9).

```jsonc
{ "job_id": "…", "kind": "library_sync", "status": "running", "terminal": false, "batch": 1000,
  "poll": { "command": "fab_job_status", "after_s": 1 } }
```

Refusals from the handler, in order:

| Code | Condition |
|---|---|
| `fab_bad_request` | params |
| `fab_unavailable` | with `reason` |
| `fab_contract_changed` | missing `library_sync_command`, `library_columns` or `data_storage` |
| `fab_not_signed_in` | D-F9 |
| `fab_job_already_running` | a sync is running; with `active_job_id` |
| `fab_sync_too_recent` | the last sync started less than 60 s ago in this editor session; with `retry_after_s` |

Refusals from the router: `editor_unsafe_restart_required`, `pie_active`, `lease_conflict`, `owner_required`.

### 6.8 `fab_library_read`

Params: `{ "name_filter"?: string, "type_filter"?: string, "limit"?: integer 0..200 default 50, "offset"?: integer ≥ 0 default 0 }`.

- `name_filter` is a case-insensitive substring of the title.
- `type_filter` matches `item_kind` or `listing_type`, case-insensitive, whole value.
- `limit: 0` returns no items and is the cheap way to read `sync_state`.

```jsonc
{
  "items": [
    {
      "id": "0a1b2c3d-…",                 // the row's AssetId, lower-case with hyphens
      "namespace": "…",
      "title": "…",
      "listing_type": "…",                 // Fab's value, unchanged
      "source": "…",                       // Fab's value, unchanged
      "seller": "…",
      "distribution_method": "…",
      "item_kind": "unknown",              // closed set, below
      "url": "…",
      "thumbnail": { "url": "…", "width": 0, "height": 0, "type": "…" },   // or null
      "size_bytes": null,                  // Fab stores no size
      "size_known": false,
      "in_project": { "present": null, "paths": [], "join": "unverified" }    // true or false, and "by_recorded_id", once V5 is settled
    }
  ],
  "total": 0, "offset": 0, "limit": 50, "has_more": false,
  "sync_state": "succeeded",               // "never" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled"
  "synced_at": "2026-09-28T10:00:00Z",     // null when never
  "stale": false,                          // true when items come from the last good snapshot
  "sync_error": null,                      // { "code", "reason", "message" } after a sync that did not succeed
  "warnings": []
}
```

**`item_kind` is a closed set:** `gltf_fbx`, `megascans_3d`, `megascans_surface`, `ue_pack`, `plugin`, `metahuman`, `unknown`.

- The mapping from Fab's values to that set is a table in `HaybaFabVerified.h`. Probe P10 fills it.
- Until then the table is empty, every row is `unknown`, and `type_filter` matches `listing_type` only.

**Which field names a listing.** A caller that wants to open or add a library item passes `items[].url` as `listing`. It does not pass `items[].id`: whether the row id is the listing id is unverified (V5).

Rules:

- Rows are read through `ICoreProvider`. The two Fab columns are found by reflection path; the URL and web-image columns are public types.
- A row whose `AssetId` parses to a zero GUID is skipped and counted in the warning `rows_skipped_zero_id`.
- A missing field is `null`. It is never an empty string presented as a value.
- There is no engine-version compatibility field. Fab's parser drops that data (`F58/Private/Teds/FabMyFolderIntegration.cpp:228-240`).
- `in_project` joins the row id against Fab's recorded ids, read from the saved config file (section 11.5). Until the join is proven, `present` is `null` and `join` is `"unverified"`.
- When the last sync did not succeed, `sync_state` says so, and `items` comes from the last good snapshot with `stale: true`, or is empty when there is none. **An empty `items` with a `sync_state` other than `succeeded` is not an empty library.**
- Titles and sellers of the person's library go to the caller. The tool description says so (section 7.7).

Refusals from the handler: `fab_bad_request`, `fab_unavailable`, `fab_contract_changed`.
Refusals from the router: `editor_unsafe_restart_required`.

---

## 7. MCP tools

### 7.0 Common rules

- Seven hand-written descriptors in `STANDARD_DESCRIPTORS`, in one block in `N/src/tools/index.ts`. They arrive plan by plan (section 16.2).
- Every schema is strict. An unknown key is refused with `fab_bad_request` before anything reaches the socket, except the named keys of section 6.3, which keep their own codes.
- A tool result is one JSON object. A refusal is `{ "ok": false, "code", "error", "hint", …detail }` with `isError: true`.
- **Every tool has one exact description string.** They are given below and are built from section 2.5. `fab-tools.test.ts` compares them.
- **Missing satellite.** A reply of `Unknown command` for a `fab_*` wire command becomes `{ "ok": false, "code": "fab_satellite_missing", "hint": … }` with the hint of Appendix A.3. The satellite registers at `PostEngineInit`, after the core's TCP server has started, so the hint also says that the editor may still be starting.
- **No wire command name in a result.** The wire replies carry `poll: { "command": "fab_job_status", "after_s" }`. Node replaces it with `poll: { "tool": "hayba_fab_job_status", "after_s" }`, because an agent cannot call a wire command. `fab-tools.test.ts` asserts that no tool result contains a wire command name.
- **A found job is never an error.** `hayba_fab_job_status` and `hayba_fab_add_to_project` answer `ok: true` and `isError: false` for every job they find, whatever its `status`. The caller reads `status` and `error`.
- **Polling.** `wait_s` polls `fab_job_status` once a second. A poll that times out or meets `ECONNREFUSED` counts as busy and polling continues within `wait_s`: while Fab's import holds the game thread, the editor stops accepting connections (`N/src/tools/heavy-ops.ts:4-12`).
  - If at least one reply arrived, the tool returns the last reply plus `editor_busy: true`.
  - If none arrived, `hayba_fab_add_to_project` returns its start reply plus `editor_busy: true`, and `hayba_fab_job_status` returns `{ "ok": false, "code": "editor_busy", "job_id", "hint" }`.
- **No retry for start commands.** `fab_import_watch_start` and `fab_library_sync` are in `NON_IDEMPOTENT` (`N/src/tools/tool-executor.ts:46-175`). After a transport failure the tool returns the `transport` error and the hint "call hayba_fab_login_status and read active_jobs to find the job".
- **Redaction.** Every result passes the general boundary redaction. The Fab tools also scrub their own results first (section 11.6).

### 7.1 `hayba_fab_login_status`

Input: `{}`. Wire: `fab_status`. Output: the `fab_status` shape, unchanged.

Description: "Reports whether the engine's Fab plugin is usable in this editor and whether a Fab session is signed in. It counts signed-in accounts and reads no credential. Fab signs in only when its tab opens, so a fresh editor reads not_signed_in until then. Also lists the running Fab jobs and the outcome of the last hayba_fab_open."

### 7.2 `hayba_fab_open`

Input: `{ "listing"?: string, "query"?: string, "free_only"?: boolean }`. Wire: `fab_open`. Output: the `fab_open` shape.

Description: "Shows a Fab listing, a Fab search or Fab's home in Fab's own editor tab, for the person to look at. It returns no search results and no listing data. Pass listing (an id or a fab.com listing URL) or query, not both. The reply says that the page was requested; hayba_fab_login_status shows whether it loaded. While an import watch waits for a click, only that watch's listing is accepted. If the tab cannot show the page, it opens in the system browser instead."

### 7.3 `hayba_fab_add_to_project`

Input:

| Param | Type | Default |
|---|---|---|
| `listing` | string, required | |
| `wait_s` | integer 0..120 | 0 |
| `click_timeout_s` | integer 30..900 | 300 |
| `timeout_s` | integer 60..3600 | 900 |
| `size_warn_bytes` | 64-bit integer ≥ 1048576 | 2147483648 |

- Wire: `fab_import_watch_start`, then optional polling.
- With `wait_s` 0 the output is the start reply. It carries the core keys as empty arrays and `terminal: false`.
- With `wait_s` above 0 the tool polls **until `terminal` is true or `wait_s` has passed**. The output is the latest `fab_job_status` reply plus `waited_s`, `user_action` and `preflight`.

Description: "Hayba opens the listing in Fab's own tab. You read the licence and click Add to Project. Hayba watches and reports; it downloads nothing, accepts nothing and saves nothing. Size is unknown before the click. Progress is a state plus bytes seen on disk. Cancel stops Hayba watching, not Fab's download. Fab chooses the folder. The result lists imported_paths and unsaved_packages; save the packages you choose from unsaved_packages. While the import runs, Play In Editor is refused for agents and needs a second press from the person. An archive that holds a .rar file makes Fab show a dialog that blocks the editor until the person answers. Verified kinds: {verified}. Unverified kinds: {unverified}."

`{verified}` and `{unverified}` are filled from `HaybaFabVerified.h` for the newest Fab version in it. Before any probe, every kind is unverified.

### 7.4 `hayba_fab_import_describe`

Input: `{ "listing": string, "offset"?: integer, "limit"?: integer 0..500 }`. Wire: `fab_import_describe`. Output: its shape.

Description: "Reads what a Fab import left in the project, from Fab's own record of the listing: the folder, the packages in it now, and which of them are unsaved. It needs no job, so it works after an editor restart and for imports the person made by hand. It covers only the folder Fab recorded. Megascans parent materials, MetaHumans and plugins are not covered, and a pack's record can be missing."

### 7.5 `hayba_fab_job_status`

Input: `{ "job_id": string, "wait_s"?: integer 0..120 default 0, "offset"?: integer, "limit"?: integer 0..500 }`. Wire: `fab_job_status`. Output: its shape plus `waited_s`.

With `wait_s`, the tool returns as soon as `status` differs from the `status` of **this call's first poll**, or `terminal` is true, or `wait_s` has passed.

Description: "Follows a Fab job started by hayba_fab_add_to_project or hayba_fab_library_list. A job that was found always answers ok:true; read status and error. The lists are paged with offset and limit, and counts holds their full sizes. Job ids do not survive an editor restart; use hayba_fab_import_describe then."

### 7.6 `hayba_fab_job_cancel`

Input: `{ "job_id": string }`. Wire: `fab_job_cancel`. Output: its shape.

Description: "Stops Hayba watching a Fab job and releases the job's lease. It does not stop Fab's own download or import; the person cancels that from Fab's notification. Any caller may cancel any Fab job, and a cancel by another owner is logged."

### 7.7 `hayba_fab_library_list`

Input: `{ "refresh"?: boolean default false, "wait_s"?: integer 0..120 default 30, "name_filter"?, "type_filter"?, "limit"?, "offset"? }`.

1. `fab_library_read` with `limit: 0`, to learn `sync_state`.
2. If `refresh` is set, or `sync_state` is `never`: `fab_library_sync`, then poll within `wait_s`. A `fab_job_already_running` refusal attaches to the running job.
3. `fab_library_read` with the caller's filters.

Output: the `fab_library_read` shape plus `job_id` and `waited_s`.

`sync_state` is `never` after every editor restart, so the first call in a session starts a sync without `refresh`. The description says so.

**From the job's end to the tool's answer.**

| Outcome | `ok` | `code` | `sync_state` | `items` |
|---|---|---|---|---|
| The sync succeeded | `true` | none | `succeeded` | fresh |
| `wait_s` ran out while the sync was still running | `true`, with `partial: true` | none | `running` | the last good list with `stale: true`, or none |
| The job failed with `fab_library_sync_failed` | `false` | `fab_library_sync_failed` | `failed` | the last good list with `stale: true`, or none |
| The job failed with `fab_library_sync_no_response` | `false` | `fab_library_sync_no_response` | `failed` | the same |
| The job failed with `fab_not_signed_in` | `false` | `fab_not_signed_in` | `failed` | the same |
| The job failed with `editor_unsafe_restart_required` | `false` | `editor_unsafe_restart_required` | not read | none: the read is refused while the editor is unsafe |
| The job ended `timed_out` | `false` | `fab_library_sync_failed`, reason `timed_out` | `timed_out` | the last good list with `stale: true`, or none |
| The job ended `cancelled` | `false` | `fab_library_sync_failed`, reason `cancelled` | `cancelled` | the same |
| The start was refused | `false` | the refusal's code | unchanged | not read |

- `sync_error.code` carries the job's error code. For `timed_out` and `cancelled` the job has no error, and the tool sets `fab_library_sync_failed` with the reason.
- When the engine is 5.8 or later and the reason is `request_failed_or_not_json`, the answer adds `upstream_suspected: true` (RK1). The hint then says that the request is Fab's own and that the library is still visible in the Fab tab.
- A satellite that unloads during a sync ends the job with `fab_satellite_unloaded`. The tool cannot see that code: by then every `fab_*` command answers `Unknown command`, which is `fab_satellite_missing`.

Description: "Lists the person's Fab library from the rows that Fab's own sync stored. If no sync ran in this editor session, or refresh is true, it first asks Fab to sync, and Fab then sends one signed-in request per page; syncs are at least 60 s apart. Titles and sellers from the person's library are returned to the caller. A sync that did not succeed is reported as a failure, never as an empty library. To open or add an item, pass its url as listing. Fab stores no size and no engine compatibility. Unverified on: {unverified_engines}."

`{unverified_engines}` names every engine on which probe P9 has not passed.

### 7.8 Tools that are not registered

`hayba_fab_marketplace_search` and `hayba_fab_download` are not registered in Stage 1. A registry test asserts that (section 12.3).

**The decision rule for the library tool.** A tool that can answer nothing on the first consumer's engine is not shipped without a decision.

- If probe P9 passes on 5.8, plan 4 is built.
- If P9 fails on 5.8, plan 4 is **not built** until the maintainer decides whether a 5.7-only tool is worth shipping.
- The other six tools ship regardless.

### 7.9 The five layers, applied

| Layer | For the Fab commands |
|---|---|
| 1. Declare | Eight names in `FHaybaMCPFabHandler::GetCommands()` and eight branches in `Handle()`, added plan by plan |
| 2. Sidecar descriptor | Eight entries in `sidecar.json`, appended as one block, with `handler_cpp: "FHaybaMCPFabHandler::Handle"` and notes that say the satellite is optional |
| 3. `returns` | Every entry lists the top-level keys of its reply, as in section 6 |
| 4. Flags | `has_ts_wrapper: true`, because the wrappers call `executeCommand('<name>')` with a literal. `agent_callable: false`, so the commands are documented by `get_tool_signature` but reached only through the seven tools, which enforce the strict schemas. This pair of values is new: of the 160 sidecar entries today, 112 are callable without a wrapper, 44 are callable with one, and 4 are neither (V15) |
| 5. `list-tool-categories` | The seven tools appear in the domain `fab` by themselves: the callable half is derived from the registry, and `domainOf('hayba_fab_open')` is `fab`. **No `DOMAINS` rows are added**: that array lists plugin commands no wrapper reaches, and listing wrapped wire names there would report them as unavailable. `inferDir()` gets its `hayba_fab_` rule back |

Static checks that must learn the satellite in the same commit (ADR-0007):

- `no-stub-wrappers.test.ts`: add the `HaybaMCPFab` private folder to `SATELLITE_HANDLER_DIRS`.
- `wire-command-names.test.ts`: scan the satellite source folders as well as the core's, so a Fab command is proven by its C++ and not only by its sidecar entry.
- `packs.yaml`: add the tools of the plan to the connectors pack.

---

## 8. The watch state machine

`HaybaFab::FWatchMachine` lives in `HaybaFabWatchPolicy.h`. It is pure: no `GEditor`, no file access, no Slate, no clock of its own. The driver passes the time and the facts on every tick and performs the one action the machine returns. It has the same form as the batch machine (`P/Private/HaybaMCPBatchPolicy.h:228-247` `@leases`).

This section is the hypothesis that the probes test (D-F20).

### 8.1 States

| State | Meaning | Terminal |
|---|---|---|
| `opening` | The listing was requested; the navigation is not confirmed yet | no |
| `waiting_for_user` | The listing is shown, or the person was told where to find it. Nothing proves a click yet | no |
| `downloading` | Fab logged the click. No asset has changed yet | no |
| `importing` | Assets change, or Interchange is active | no |
| `succeeded` | The import settled (section 8.5) | yes |
| `failed` | Fab reported a failure, the tab closed and nothing followed, or the editor became unsafe | yes |
| `cancelled` | The caller cancelled the watch, or the person cancelled in Fab's notification | yes |
| `timed_out` | A deadline passed: the one for the click or the one for the import | yes |
| `abandoned` | The Fab tab was closed before any click | yes |

A terminal decision is not yet a terminal reply. Between the two the job is `finalizing` (section 8.6).

### 8.2 Words used below

| Word | Meaning |
|---|---|
| **Click event** | Fab's log line `Add listing to project - <id>` or `Drag listing to project - <id>`, with an id that matches the pattern of section 6.2 |
| **Tracked listing** | An id from a click event during this job. The driver keeps the set |
| **Primary listing** | The requested id when it is tracked; otherwise the first tracked id |
| **Recorded** | A tracked listing is recorded when Fab's record maps a folder to its id **and** at least one asset under that folder changed since the click |
| **Pending** | A tracked listing that is not recorded |
| **Candidate roots** | `/Game/Fab`, every top-level `/Game` folder that did not exist when the job started, and every folder that a new or changed entry of Fab's record names |
| **Settled for N** | For N seconds in a row: Interchange was idle **and** no asset under a candidate root changed |

### 8.3 Inputs, per tick

```cpp
struct FInputs
{
    double Now = 0.0;                  // injected clock, seconds

    // Click evidence
    int32  ClickEvents = 0;            // click events drained this tick
    int32  TrackedListings = 0;        // over the whole job
    int32  PendingListings = 0;        // tracked and not recorded
    EFabListingType PrimaryType = EFabListingType::Unknown;   // from "Listing type - ", closed set
    bool   bClickEventsVerified = false;                      // contract item log_events_verified

    // Activity
    int32  NewChanges = 0;             // registry adds and updates under the candidate roots, drained this tick
    bool   bInterchangeActive = false; // UInterchangeManager::IsInterchangeActive()
    bool   bAllChangesUnderMetaHuman = false;   // over the whole job, not only this tick
    bool   bNewTopLevelFolder = false; // a top-level /Game folder that did not exist at the start holds a change
    int64  CacheGrowthBytes = 0;       // peak growth of <cache>/<id>, summed over the tracked listings; -1 when unmeasured

    // Tab
    bool   bListingShown = false;      // the navigation was confirmed
    bool   bTabAlive = false;          // the weak pointer of section 6.2 is valid
    bool   bTabShowsListing = false;   // the tab's URL still names the requested listing

    // Editor
    bool   bPieActive = false;
    bool   bCancelRequested = false;
    bool   bEditorUnsafe = false;

    uint32 Events = 0;                 // bit set of the other EFabLogEvent values seen this tick (section 11.7)
};
```

- The machine holds no paths and no ids. The driver does.
- A count, not a bit, carries the click events. Two clicks in one tick are two.

### 8.4 Timers

All are fields of `FTuning`, so tests can shrink them and a probe can change them (D-F20).

| Timer | Default | Use |
|---|---|---|
| `ClickTimeoutSeconds` | 300 (from `click_timeout_s`, 30 to 900) | deadline for `opening` and `waiting_for_user`, from the start |
| `TimeoutSeconds` | 900 (from `timeout_s`, 60 to 3600) | deadline for `downloading` and `importing`, from the first click evidence |
| `OpenTimeoutSeconds` | 20 | how long `opening` waits for a confirmed navigation |
| `TabCloseGraceSeconds` | 2 | a tab must stay closed this long to count as closed; docking a tab closes and reopens it |
| `QuietSeconds` | 3 | the settle time for a recorded import |
| `MetaHumanQuietSeconds` | 10 | the settle time of the MetaHuman rule |
| `RecordGraceSeconds` | 15 | the settle time of the rules that have no record |
| `StallWarnSeconds` | 120 | no evidence of any kind after the click |
| `TabClosedFailSeconds` | 120 | no evidence of any kind after the tab closed |
| `MinGrowthBytes` | 65536 | cache growth that counts as evidence of activity |
| `StallGapSeconds` | 2 | a gap between two ticks above this is a stall |

**Stalls.** The game thread can be blocked for minutes: Fab's `.rar` dialog, a copy with a progress dialog, a long import. The pump does not tick then.

- When `Now - LastTickAt` is above `StallGapSeconds`, the machine moves `StartedAt`, `ClickedAt` and every running timer forward by that gap, before it evaluates anything.
- A deadline therefore counts ticked time. A block never makes a job time out, and it never makes quiet time pass.
- `stalled_s` in the status is the sum of the gaps. `elapsed_s` stays wall time.
- This mirrors the pause-aware hold of the P0 batch pump (P0 task T2).

Driver cadences, outside the machine:

| Read | Cadence |
|---|---|
| registry, log, Interchange, tab and PIE | every tick |
| the result of the cache measurement and of the record read (section 10.3) | every tick; the work itself runs off the game thread, at most once a second |
| progress | published at most four times a second |

### 8.5 Transitions

Each tick evaluates in this order. The first terminal result wins.

**0. Stall shift** (section 8.4).

**1. Global stops, from any non-terminal state.**

| Condition | To | Error code |
|---|---|---|
| `bEditorUnsafe` | `failed` | `editor_unsafe_restart_required` |
| `bCancelRequested` | `cancelled`, reason `caller` | none |
| event `fab_cancelled_by_user` | `cancelled`, reason `fab_notification` | none |
| event `download_failed` | `failed` | `fab_download_failed` |
| event `import_failed` | `failed` | `fab_import_failed` |
| event `import_rejected` | `failed` | `fab_import_rejected` |

These lines carry no id that Hayba can trust. They therefore end the job however many listings are tracked. The result still says which tracked listings were recorded by then.

**2. Latches.** They change no state.

| Condition | Effect |
|---|---|
| `bPieActive`, first time | `pie_started_during_job = true` and the warning `pie_started_during_job`. **The job does not stop, pause or refuse anything: PIE starting mid-job is flagged, not acted on** |
| `CacheGrowthBytes >= size_warn_bytes`, first time | `size_warning` is set with the bytes and the time. **It fires once. It is never cleared and never repeated** |
| `CacheGrowthBytes == -1` | `cache_measured = false`, once |
| event `already_processing` | the warning `fab_already_processing`: Fab ignored a click because it is already working on that listing |
| event `parent_materials_copy_started` | remember that the copy was seen (section 8.6) |
| event `parent_materials_copy_failed` | the warning `megascans_parent_materials_copy_failed` |
| event `rar_skipped` | the warning `rar_files_skipped` |
| event `plugin_install` | the warning `plugin_install_not_watched`. It is not a click event |
| `bClickEventsVerified`, no click event so far, and `NewChanges > 0` | the warning `activity_without_click`, once. **No state changes** |
| `waiting_for_user`, `bTabAlive`, and not `bTabShowsListing` | the warning `listing_navigated_away`, once |
| `TrackedListings > 1`, first time | the warning `other_listings_imported` |

**3. State transitions.**

| From | Condition | To |
|---|---|---|
| `opening` | `bListingShown` | `waiting_for_user` |
| `opening` | `OpenTimeoutSeconds` passed | `waiting_for_user`, with the action `FallBackToSystemBrowser` and the warning `listing_not_shown_in_editor` |
| `opening`, `waiting_for_user` | `ClickEvents > 0` | `downloading`, with the action `AcquireLease`. `ClickedAt` is set |
| `opening`, `waiting_for_user` | **only when `bClickEventsVerified` is false:** `NewChanges > 0` | `importing`, with the action `AcquireLease` and the warning `click_not_observed`. `ClickedAt` is set |
| `opening`, `waiting_for_user` | the tab was resolved, and `bTabAlive` has been false for `TabCloseGraceSeconds` | `abandoned` |
| `opening`, `waiting_for_user` | `ClickTimeoutSeconds` passed since the start | `timed_out`, waiting for `click` |
| `downloading` | `NewChanges > 0`, or `bInterchangeActive` | `importing` |
| `downloading` | no change, no event and no growth of `MinGrowthBytes` for `StallWarnSeconds` | stays; the warning `download_stalled`, once |
| `downloading`, `importing` | the tab was resolved, and `bTabAlive` has been false for `TabCloseGraceSeconds` | stays; the warning `fab_tab_closed_during_import`, once |
| `downloading`, `importing` | after that warning, no change, no event and no growth for `TabClosedFailSeconds` | `failed`, code `fab_tab_closed` |
| `importing` | `NewChanges > 0`, or `bInterchangeActive` | stays; the settle time starts again |
| `importing` | settled for `QuietSeconds`, `TrackedListings >= 1` and `PendingListings == 0` | `succeeded`, `attribution: "fab_recorded"` |
| `importing` | `TrackedListings == 1`, `PrimaryType` is `metahuman`, `bAllChangesUnderMetaHuman`, settled for `MetaHumanQuietSeconds` | `succeeded`, `attribution: "metahuman_rule"`, the warning `unverified_kind` |
| `importing` | `TrackedListings == 1`, `PrimaryType` is `unreal-engine`, `bNewTopLevelFolder`, settled for `RecordGraceSeconds` | `succeeded`, `attribution: "pack_rule"` |
| `importing` | settled for `RecordGraceSeconds` | `succeeded`, `attribution: "unconfirmed"`, the warning `unattributed_import` |

**4. Import deadline.** If the state is `downloading` or `importing` and `TimeoutSeconds` has passed since `ClickedAt`: `timed_out`, waiting for `import`. The success check of step 3 runs before this one, so an import that settles on the deadline tick succeeds.

What the order guarantees:

- **No exit from waiting without a click** (D-F15). On a verified Fab version, the only ways out of `waiting_for_user` are a click event, a closed tab, the click deadline, a cancel and an unsafe editor.
- **No success while Interchange runs.** On a first Megascans import, Fab copies the parent materials and only then starts the import. The registry reports the materials early, and a long silent phase can follow while textures and meshes build. The settle time does not run in that phase, because Interchange is active. Fab writes its record in the completion callback, so `fab_recorded` cannot fire early either.
- **No success while a second listing is pending.** Success through `fab_recorded` needs every tracked listing to be recorded.
- **The record gets its chance first.** The rules without a record wait `RecordGraceSeconds`, which is longer than `QuietSeconds`.

### 8.6 What the driver does at the end

**Finalizing.** When the machine returns a terminal decision, the job is not terminal yet.

1. `status` keeps its last non-terminal value, `phase` is `finalizing`, and `terminal` is false.
2. The driver attributes the changes (table below). On 5.8, when the preflight said `will_be_copied_and_saved` or the copy was seen in the log, it lists the packages under `/Game/Fab/Materials` from the registry directly. It does not rely on the timing of registry events for them.
3. The driver asks the backend which of the imported packages are dirty or have no file on disk. It works in slices of at most 2 ms per tick.
4. It stores the full lists in the result store (section 10.4) and the summary in the registry.
5. It releases the job lease, stops the log capture and unsubscribes from the registry and from Interchange.
6. It calls `SetDone` with exit code 0 for `succeeded` and 1 for every other terminal state. **Only now** does a status reply read the terminal `status` and `terminal: true`.
7. It removes its ticker.

A poll can therefore never read `succeeded` together with arrays that are not computed yet.

**Attribution of the changes.** Attribution is a pure function, `HaybaFab::Attribute`, in `HaybaFabAttribution.h`. It takes the buffered changes, the tracked ids, Fab's record and the folder snapshot, and returns the lists. The driver buffers every registry add and update under `/Game` from the start of the job. Changes before the first click evidence belong to nobody: they are counted in `observed.changes_before_click` and appear in no array.

| `attribution` | `imported_paths` holds the changes since the click that lie under |
|---|---|
| `fab_recorded` | the folder Fab recorded for the primary listing; plus `/Game/Fab/Materials` as in step 2 |
| `pack_rule` | the top-level `/Game` folders that did not exist at the start |
| `metahuman_rule` | `/Game/Fab/MetaHuman` |
| `unconfirmed` | the candidate roots |
| none, because the job did not succeed | the same as `unconfirmed`, or as `fab_recorded` when the primary listing was recorded by then |

- **The primary listing decides `attribution`.** The last rule of section 8.5 also ends a job in which the primary listing is recorded and another tracked listing never is. The result then reads `fab_recorded`, `imported_paths` is limited to the primary listing's folder, and the other listing has `outcome: "pending"`.
- A change under the folder of **another** tracked listing is counted in `other_listings[].imported_count` and is in no array.
- Every other change under `/Game` since the click goes to `unattributed_changes`, with the warning `paths_outside_record`.
- One recorded folder is enough for `fab_recorded`. A change outside it never blocks that attribution; it only moves to `unattributed_changes`.
- Because the buffer covers all of `/Game`, a re-import into a pack folder that already existed is seen too: the folder becomes a candidate root as soon as Fab's record names it.

**When the job stops without the backend.** The unsafe stop and the unload of the satellite finish the job without any backend call (section 10.3).

- `evaluated` is false and `evaluated_at` is null.
- `imported_paths` holds what was collected, attributed with the last record that was read.
- `unsaved_packages` and `saved_by_fab` are empty, and the warning `partition_not_evaluated` says that they were not computed.

### 8.7 The named cases

| Case | Behaviour |
|---|---|
| **MetaHuman without a record** | The MetaHuman workflow never records an entry. The job succeeds through the MetaHuman rule, with the warning `unverified_kind` |
| **A pack whose record is removed** | Fab records a pack's folder before the registry knows it, and the record's own clean-up can remove the entry (section 3.2). The job then succeeds through the pack rule. Probe P6 records whether the entry survives |
| **A plugin listing** | Fab installs it through another entry point and outside `/Game`. Its log line is not a click event. The job adds the warning `plugin_install_not_watched`, keeps its state, and ends `timed_out`, waiting for `click`, with the note of Appendix A.4 that plugin listings are not supported |
| **A dragged listing** | The drag line is a click event. The job follows the import the same way and adds the warning `unverified_kind` |
| **Abandoned on tab close** | Only while `opening` or `waiting_for_user`, only if a Fab tab was resolved during the job, and only after the grace. If the listing went to the system browser and no Fab tab was ever resolved, the job cannot be abandoned; it reaches the click deadline |
| **Tab closed after the click** | First a warning. Fab releases the object that owns the workflows 1.5 s after the tab closes, so the import most likely never completes. If nothing follows for `TabClosedFailSeconds`, the job ends `failed` with `fab_tab_closed` and releases its lease. Probe P7 settles whether it should stop at once |
| **Several tabs on 5.8** | The job follows the tab it navigated. Closing another Fab tab changes nothing. Fab's duplicate check is per tab, so the same listing can run twice from two tabs; both runs carry the same id and count as one tracked listing |
| **A second listing** | It becomes a tracked listing. The job succeeds only when every tracked listing is recorded, and reports the others in `other_listings` |
| **A different listing** | If the person adds another listing instead of the requested one, that one is the primary listing. The job succeeds with `listing_match: "false"` and the warning `different_listing_imported`. `listing_match` is decided from the ids in the click events, not from Fab's record: it is `true` as soon as the requested id is tracked |
| **`timed_out` after the click** | Also the outcome of Fab behaviours that leave no line Hayba maps: a failed pack download whose cause the downloader did not log, and Fab's hang on an unknown Megascans sub-type when its line was not seen. The reply then adds the note that Fab will refuse the same listing until its tab is reopened |
| **The one-shot size warning** | It counts the bytes under `<cache>/<listing id>` only, so another editor's download is not counted. The bytes include unpacked archives, so they are an upper bound on the download. The warning says so |
| **PIE starting mid-job** | Flagged in `pie_started_during_job`. After the click the job lease makes this rare: an agent's `editor_start_pie` answers `asset_busy`, and the person's Play button is vetoed by P0 T10 with a double-press override. Before the click nothing is held, and nothing is being written |
| **Editor unsafe** | The pump finishes the job as failed without calling the backend again (section 10.3) |

---

## 9. The library sync machine

`HaybaFab::FSyncMachine`, in the same header, with the same injected clock and the same stall shift.

| Input | Meaning |
|---|---|
| `Now` | injected clock |
| `RowCount` | rows in the `Fab` table |
| `Batch` | the page size the sync was started with |
| `Events` | `response_received`, `page_parsed`, `sync_not_signed_in`, `sync_request_failed`, `sync_invalid_json`, `sync_missing_results`, `sync_storage_unavailable` |
| `bCancelRequested`, `bEditorUnsafe` | as in section 8 |

| Timer | Default | Use |
|---|---|---|
| `SyncQuietSeconds` | 10 | the wait after a page that was not full |
| `PageWaitSeconds` | 60 | the wait for the next response after a full page |
| `NoResponseSeconds` | 30 | the wait for the first event |
| `SyncTimeoutSeconds` | 300 | the deadline of the job |

**A full page.** The rows a page added are the difference in `RowCount` between two `page_parsed` events. A page is full when it added exactly `Batch` rows. Fab removes rows it could not read, so a full page can look short; that is why a success after a short page says `complete: "assumed"`.

Rules, in order:

| Condition | Result |
|---|---|
| `bEditorUnsafe` | `failed`, `editor_unsafe_restart_required` |
| `bCancelRequested` | `cancelled` |
| `sync_not_signed_in` | `failed`, code `fab_not_signed_in` |
| `sync_request_failed` | `failed`, code `fab_library_sync_failed`, reason `request_failed_or_not_json` |
| `sync_invalid_json` | `failed`, reason `invalid_json` |
| `sync_storage_unavailable` | `failed`, reason `storage_unavailable` |
| `sync_missing_results` **after** at least one `page_parsed` in this job | `succeeded`, `complete: "end_of_list"`. An empty page after good pages is the end of the list |
| `sync_missing_results` with no page parsed | `failed`, reason `missing_results_or_empty_library`. Fab logs the same line for an error and for an empty library, and Hayba never reads the line's text |
| the last page was **not** full, then no event and no row-count change for `SyncQuietSeconds` | `succeeded`, `complete: "assumed"` |
| the last page was full, then no event for `PageWaitSeconds` | `succeeded`, `complete: "assumed"`, the warning `sync_last_page_full` |
| no event of any kind for `NoResponseSeconds` since the start | `failed`, code `fab_library_sync_no_response` |
| `SyncTimeoutSeconds` since the start | `timed_out` |

- Fab queues the request for the next page before it stores the current one. After a full page the machine therefore expects another response and waits for it. It does not succeed on a short silence.
- If Fab cannot copy its own credential, it logs nothing at all. The `NoResponseSeconds` rule covers that.
- The machine needs these log lines because Fab offers no completion callback. If a future Fab changes the wording, no event is recognised, the job ends as `fab_library_sync_no_response`, and `unrecognised_log_lines` shows that something was logged. It fails closed.
- Probe P9 runs with `batch: 5` on an account that owns at least six items, so that paging and the last page are exercised. It records the time between pages.

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

- **Progress JSON** is the job's own status record. For a Fab job it is the `fab_job_status` reply without the paged arrays. The registry treats it as text and refuses more than 16 KiB.
- **Statuses stay job-specific.** `waiting_for_user` and the rest live in the progress record's `status`. The terminal status lives in the output's `status`. `ExitCode` is 0 for `succeeded` and 1 otherwise, so `build_status` keeps meaning `ok = exit_code == 0`.
- **The cancel flag is generic.** It is a request, not an action: the job's own pump decides what stopping means. A later `batch_cancel` can use the same flag; this spec does not build it.
- **The output of a Fab job** is its status record with `counts`, `imported_roots` and the first 200 entries of each paged array. The Fab pump keeps it below 256 KiB. That bound is the Fab pumps' own; the registry does not cut the output of a build or a batch job.
- **`build_status`** adds `progress` (the parsed object) when a job has one, and `cancel_requested`. Its existing keys do not change.
- **Everything is scrubbed before it is stored** (section 11.6). `build_status` can read a Fab job's output, so the registry must never hold an unscrubbed string.
- **Not changed here:** jobs are still never removed from the registry.

### 10.3 The pump preamble

Both Fab pumps are `FTSTicker` core-ticker delegates. They never use `AsyncTask(GameThread)` and never wait for the game thread. Each tick runs in this order, which mirrors the batch pump preamble of the P0 spec (section 3.0 there):

1. If the job is finished, remove the ticker and return.
2. **Unsafe stop.** If `IsEditorUnsafe()`: finish the job as failed with `editor_unsafe_restart_required`, release the lease (a pure table operation), stop the captures, and return. The backend is not called again, and the result is the one of section 8.6, "when the job stops without the backend".
3. **Lease keep-alive**, before any backend call. It applies once the job has acquired its lease.
   - The lifetime is `min(900, timeout_s)` seconds.
   - The pump renews when a third of the lifetime has passed.
   - If the lease has lapsed, because the game thread was blocked for longer than its lifetime, the pump acquires it again at once. If another owner holds the key by then, the job continues with the warning `lease_not_held`.
4. **Gather** the inputs from the backend, at the cadences of section 8.4. The backend calls run inside the seam's `RunGuarded`.
5. **Tick** the machine and perform its one action. `AcquireLease` acquires the job lease through the host functions of section 12.1; a failure adds the warning `lease_not_held` and changes nothing else.
6. **Publish** progress, or run one slice of the finalizing of section 8.6.

**Work off the game thread.** Three reads are too slow for the game thread and touch no engine object: the size of a listing's cache folder, Fab's record in the saved config file, and the size of the whole cache folder for `fab_status`.

- Each runs as a thread-pool task, at most one of each kind at a time and at most once a second.
- A task holds only copies of the paths it reads and a shared result object. It touches no `UObject`, and it never calls back to the game thread.
- The pump reads the latest finished result on its tick. It never waits for a task.
- The cache task measures `<cache>/<listing id>` for each tracked listing, not the whole cache. It reports the **peak** growth since the click, because the staging files of a pack are removed when the download ends. It stops after 20,000 directory entries in one folder and reports `cache_measured: false`.
- Before the click there is no tracked listing, so nothing is measured for a job.
- The task for `fab_status` walks the whole cache. It stops after 200,000 directory entries and then reports no value, so `cache_bytes` is `null`.
- At shutdown the module sets a stop flag, which a task checks at every directory entry, and then joins the at most three tasks. That wait is for a worker that needs nothing from the game thread.

**The budget.** The pump measures its own game-thread time. A tick over 5 ms adds the warning `pump_budget_exceeded` once.

**Unload.** When the satellite module shuts down, every running Fab job is finished as failed with `fab_satellite_unloaded`, in the way of step 2, and its lease is released.

### 10.4 The result store

The registry holds text and has a size bound. The full lists of an import job therefore live in the satellite.

- The store maps a job id to the five sorted lists of section 6.5.
- It keeps the lists of the last eight finished import jobs and of the running one. When a ninth finishes, the oldest is dropped, and its status reads `arrays_expired: true`.
- It lives in memory. After an editor restart it is empty, like the registry. `fab_import_describe` is the way to read an import then.
- `fab_job_status` reads it and nothing else besides the registry, which is why the command qualifies for `StatusOnlyCommands()`.

---

## 11. Safety rules

### 11.1 The three things the tools must never do

1. **Read an auth token.**
2. **Run `EOSSDK INFO`.**
3. **Accept a licence.**

### 11.2 What follows from them

| Never | Because |
|---|---|
| call `EOS_Auth_CopyUserAuthToken`, `EOS_Auth_CopyIdToken`, or any `LogInfo` / `LogAuthInfo` function of the EOS manager or a platform handle | they return or log the credential (`E58/Private/EOSSDKManager.cpp:1340-1390`) |
| call any `EOS_` function outside the four of section 6.1 | the allowlist is closed |
| convert an account id to text (`EOS_EpicAccountId_ToString`), or log, store or return it | it identifies the person |
| call `GetAuthToken` or `GetRefreshToken` on `UFabBrowserApi`, by reflection or otherwise | they return the credential (`F58/Private/FabBrowserApi.cpp:513-528`) |
| read the `CustomAuthToken` property of Fab's settings, or load the asset `/Fab/Data/FabEos` | both hold credentials |
| read `AUTH_PASSWORD` or `AUTH_TYPE` from the command line | Fab's fallback sign-in reads an exchange code there (`F58/Private/FabAuthentication.cpp:258-266`) |
| call `AddToProject`, `InstallToProject`, `InstallToEngine`, or any function of Fab's bridge | that would impersonate the page, and it is where a licence is accepted |
| run JavaScript in Fab's tab | the page contract is Epic's, and the page can reach the credential getters |
| run `Fab.Login`, `Fab.Logout`, `Fab.SetEnvironment` or `Fab.ClearCache` | they change the user's session, environment or cache |
| load a URL in Fab's tab whose scheme, host or path came from the caller (D-F11) | the bridge is bound to that browser |
| store, log or return the URL that Fab's browser shows | it can carry sign-in values in its query |
| use the library sync as a status probe | it makes Fab send a signed-in network request |

A Node source-scan test asserts all of this for the satellite's source:

- None of these strings appears: `CopyUserAuthToken`, `CopyIdToken`, `LogAuthInfo`, `GetAuthToken`, `GetRefreshToken`, `CustomAuthToken`, `FabEos`, `AUTH_PASSWORD`, `AddToProject`, `InstallToProject`, `InstallToEngine`, `ExecuteJavascript`, `EOSSDK INFO`, `EOS_EpicAccountId_ToString`, `Fab.Login`, `Fab.Logout`, `Fab.SetEnvironment`, `Fab.ClearCache`.
- The only symbols that start with `EOS_Auth_` or `EOS_Platform_` are `EOS_Platform_GetAuthInterface`, `EOS_Auth_GetLoggedInAccountsCount`, `EOS_Auth_GetLoggedInAccountByIndex` and `EOS_Auth_GetLoginStatus`.
- The satellite names exactly one console command, `Fab.TEDS.MyFolderIntegration`, and passes no caller text to the console.
- None of the four dead wire names appears as a string literal.
- The scan strips comments first and asserts a minimum number of scanned files, so it fails closed.

The same scan is run by hand on the probe plugin before it is built (section 13.1).

### 11.3 PIE

- **At start:** the router refuses with `pie_active` (P0 T2). The handler has no check of its own.
- **During a job:** flagged in `pie_started_during_job`, never acted on. The job neither stops PIE nor pauses.
- **Before the click:** the job holds no lease. An agent can start PIE, and the person can press Play. Nothing is being written then.
- **From the click to the end:** the job lease makes an agent's `editor_start_pie` and `editor_save_all_and_quit` answer `asset_busy` (P0 T3, `AnyBusyCommands`). P0 T10 vetoes the person's Play button with a double-press override. Another owner's `python_run` that declares no resources conflicts with the lease (P0 T8).
- The two job commands answer during PIE.

### 11.4 Saving

- Hayba saves nothing in any Fab tool. There is no `save` param.
- `unsaved_packages` lets the caller save exactly what it chooses, by pathspec, with Hayba's save tools. Those tools carry the `package_read_only` preflight (P0 T5).
- What Fab saved by itself is reported in `saved_by_fab`, because Hayba cannot prevent it. On 5.8 that includes the Megascans parent materials. Packs are written to disk directly.
- Fab rewrites its Megascans parent settings in the same step as the copy. They are a config file, not a package, so they are in no list. The job adds the warning `megascans_parent_settings_rewritten` when it saw Fab's line `Copying Fab parent materials to …`, or when the preflight said `will_be_copied_and_saved` and `/Game/Fab/Materials` holds packages at the end.

### 11.5 Read-only files and source control

- The preflight warns when files under `Content/Fab` are read-only. It uses the same check as `HaybaSaveVerify::FindReadOnlyPackageFiles` and names the source-control provider. It never clears a read-only flag.
- It is a warning, not a refusal. Hayba is not the writer, and it does not know the exact target before the click.
- A pack's files are written to disk under the editor, outside source-control checkout. The job reports the paths it saw change; it cannot list a pack's target in advance.
- **Fab's record is read from the saved config file**, not from the live object. Fab mutates and saves that object on a task-graph thread (section 3.2). Hayba reads the file off the game thread (section 10.3) with a bounded read, parses only the section `[/Script/Fab.FabLocalAssets]`, tolerates a half-written file by trying again on the next read, and never parses or returns any other section of that file.

### 11.6 Redaction of token-shaped strings, on both sides

| Side | Rule |
|---|---|
| Editor, satellite | `HaybaFab::Scrub` runs on every string before it enters a response, a progress record, a job output, the result store or a log line. It replaces JWTs (`eyJ….….…`), `eg1~…` values and `Bearer …` values with `[REDACTED:token]` |
| Editor, core | The final envelope redaction still runs on every response. It gains the `eg1~` pattern (C5) |
| Node, Fab tools | `scrubFabResult` runs on every Fab tool result with the same three patterns |
| Node, boundary | `redactMcpResult` still runs on every tool result. It gains the `eg1~` pattern (C5) |

- The pattern for the new prefix is `\beg1~[A-Za-z0-9._~+/=-]{16,}`.
- A generic 32-hex pattern is **not** added: it would destroy asset ids.
- Every fixed text of Appendix A and every tool description of section 7 is passed through both redactors in a test and must come out unchanged.
- URLs from Fab's feed keep their path. The existing URL rule masks secret-looking query values.

### 11.7 Log captures

- A Fab job captures the category `LogFab` only, through an output device that queues lines from any thread and is drained on the game thread.
- **A Fab job never subscribes to `LogEOSShared`, `LogEOSSDK` or `LogHttp`.** `LogEOSShared` is the category that carries the credential values after `EOSSDK INFO` (section 3.2). The core's two log readers drop both EOS categories as well (C7).
- Captured lines are never stored or returned as text. `HaybaFabLogEvents.h` maps a known message prefix to an event code and counts the rest (D-F10).
- A line that maps to nothing is counted in `unrecognised_log_lines`. If its verbosity is Error, it is also counted in `unrecognised_error_lines`. A job that times out with a count there points at a Fab line this table does not know.

| Event | Message prefix | Used by |
|---|---|---|
| `add_to_project` | `Add listing to project - ` | watch: click event |
| `drag_to_project` | `Drag listing to project - ` | watch: click event |
| `listing_type` | `Listing type - ` | watch |
| `already_processing` | `The listing with Id ` | watch |
| `download_failed` | `Failed to download `, `Invalid Manifest`, `Invalid pack - `, `Failed to load BuildPatchServicesModule`, `Failed to create the dir for writing: `, `Failed to open file for writing: `, `Failed to write data to file`, `Failed to rename downloaded file ` | watch |
| `fab_cancelled_by_user` | `Import Cancelled` | watch |
| `import_failed` | `Asset import failed: `, `Failed to import Megascan asset: `, `Import files not found for `, `Failed to unzip ` | watch |
| `import_rejected` | `Invalid Quixel asset type: `, `Asset type not handled ` | watch |
| `parent_materials_copy_started` | `Copying Fab parent materials to ` | watch |
| `parent_materials_copy_failed` | `AdvancedCopyPackages failed`, `No material packages found to copy.` | watch |
| `rar_skipped` | `'.rar' extract support is unavailable.` | watch |
| `plugin_install` | `Install plugin to project - `, `Install plugin to engine - ` | watch |
| `response_received` | `Result for (portion of) the My Folder data.` | sync |
| `page_parsed` | `Parsed data for (portion of) My Folder.` | sync |
| `sync_not_signed_in` | `Unable to retrieve My Folder data due to user not being logged into Fab.` | sync |
| `sync_request_failed` | `Unable to retrieve My Folder data due to the request failing` | sync |
| `sync_invalid_json` | `Unable to retrieve My Folder data due to returned result not being valid JSON.` | sync |
| `sync_missing_results` | `Unable to store My Folder data due missing results.` | sync |
| `sync_storage_unavailable` | `Unable to store My Folder data due the ` | sync |

Two values are taken from a line, and nothing else:

- the id after a click prefix, and only when it matches the id pattern of section 6.2;
- the word after `Listing type - `, and only when it is one of `unreal-engine`, `gltf`, `glb`, `fbx`, `metahuman`. Any other word is `other`. The word selects the rule of section 8.5 and, with the landing folder, fills `import_kind`.

### 11.8 Licences, size, leases

- **Licences.** The licence is shown to, read by and accepted by the person, on Fab's page. No param, setting or default changes that.
- **Size.** Before the start: a warning when the quality tier is `raw`. During the job: one warning when the bytes under `<cache>/<listing id>` pass `size_warn_bytes` (2 GiB by default). Neither is a gate.
- **Leases.** The job holds `asset:/Game/Fab` from the click to the end. The lease is a marker (D-F7). A response never carries a lease id. The start command claims nothing (D-F16).

### 11.9 The library sync and the network

- `fab_library_sync` is the only Hayba command that makes Fab send a network request (section 2.2). Fab sends it, with Fab's own credential, to Fab's own service. Hayba sees neither the request nor the response.
- Fab's terms have not been reviewed for automated use. The sync is therefore kept rare: at least 60 s between two starts, one sync at a time, and no sync as a side effect of any command other than `hayba_fab_library_list`.
- `hayba_fab_library_list` starts a sync by itself only when none has run in this editor session. Its description says so.
- The rows hold titles and sellers from the person's library. They go to the calling agent. The description says so.

---

## 12. The seams and the tests

### 12.1 `IHaybaFabBackend` and the host functions

Everything that touches the engine, Fab, the file system or Slate goes through `IHaybaFabBackend`. The handler, the pumps and the machines see nothing else of the engine.

| Method | Returns | Production source |
|---|---|---|
| `GetAvailability()` | available, reason, Fab version, engine version | module manager, plugin manager |
| `ProbeContract()` | the missing contract items | reflection and name lookups (section 5.5) |
| `GetSession()` | state and the three counts | EOS active platforms |
| `QualityTier()`, `ExperienceMode()` | the value, or none | reflection on Fab's settings |
| `IsProductionEnvironment()` | bool | reflection on Fab's settings |
| `IsAssetRegistryLoading()` | bool | asset registry |
| `ResolveTab()` | found or created, or none | tab manager, tool menus, the delegates of section 6.2 |
| `IsTabAlive()` | bool | the weak pointer |
| `IsTabReady()`, `TabShowsUrl(url)` | bool | `SWebBrowser::GetUrl`, compared and dropped |
| `Navigate(url)` | bool | `SWebBrowser::LoadURL` |
| `OpenInSystemBrowser(url)` | bool | platform process |
| `StartLibrarySync(batch)` | bool | console manager |
| `LibraryRowCount()` | count | editor data storage |
| `ReadLibraryRows()` | rows | editor data storage and reflection |
| `RequestCacheMeasure(ids)`, `LatestCacheGrowth()` | peak bytes, or -1 | a thread-pool walk of `<cache>/<id>` |
| `RequestRecordRead()`, `LatestRecord()` | folder to id map | the saved config file, read on the thread pool |
| `DrainRegistryChanges()` | added and updated assets under `/Game` | the asset registry's delegates, and Interchange's `OnAssetPostImport` and `OnAssetPostReimport` |
| `IsInterchangeActive()` | bool | `UInterchangeManager::IsInterchangeActive`; `OnBatchImportComplete` marks the end of a batch |
| `DrainFabLogEvents()` | event codes, click ids, the listing type, the two counts | the `LogFab` capture |
| `SnapshotTopLevelFolders()` | folder names | asset registry |
| `ListPackagesUnder(folder)` | package names | asset registry |
| `DescribePackages(packages)` | dirty, on disk, class | package and file lookups |
| `FindReadOnlyFiles(max)` | paths, provider name | file manager, source control module |
| `IsPIEActive()` | bool | `GEditor->PlayWorld` or a queued play request |

- `FHaybaFabPluginBackend` is the production implementation.
- `FHaybaFabFakeBackend` is scripted per test: sessions, library fixtures (including a zero-GUID row and rows with missing fields), cache timelines, bursts of registry changes, Interchange phases, log events, tab closes, PIE toggles, tick gaps, and notes that contain token-shaped strings. It can also replay a fixture file (section 13.1).
- The clock is a separate injection: the machines take `Now` as an input, and the pumps take a clock function.

**The host functions are not part of the backend.** The calls into the core's seam (`IsEditorUnsafe`, `CallerOwner`, the three lease calls, `FindAssetLeaseHolder`) are a struct of replaceable functions, `FHaybaFabHostOps`, in `HaybaFabHostOps.h`.

- By default they are the functions of `HaybaMCPSatelliteHost`.
- A test that needs a lapsed lease or an unsafe editor replaces them.
- The router test below does **not** replace them. It runs the real lease table with a fake Fab backend, so it proves the claim that matters: an agent cannot start PIE while an import runs.

### 12.2 Automation tests (C++)

All run under the filter `Hayba`. The filter `Hayba.MCP` would skip every Fab test.

**Pure.**

| Test | Asserts |
|---|---|
| `Hayba.Fab.Listing.ParseAndBuildUrl` | ids and the URL forms parse; the built URL has the engine's base |
| `Hayba.Fab.Listing.RejectsForeignHosts` | other hosts, other schemes, look-alike hosts and extra path segments are refused |
| `Hayba.Fab.Listing.CompareUsesExactHost` | `https://fab.com.example/…` does not compare equal; the query string is ignored |
| `Hayba.Fab.Listing.SystemBrowserGetsPublicForm` | no `/plugins/ue5` in a URL for the system browser |
| `Hayba.Fab.Listing.QueryEncodedControlCharsRefused` | the query is one encoded value; a control character is refused |
| `Hayba.Fab.LogEvents.MapKnownLines` | every row of section 11.7 |
| `Hayba.Fab.LogEvents.NeverKeepsText` | a line with a server response or a client id yields only a code or a count |
| `Hayba.Fab.LogEvents.ListingTypeClosedSet` | an unknown word is `other` |
| `Hayba.Fab.LogEvents.ErrorLinesCountedSeparately` | an unmapped Error line raises both counts |
| `Hayba.Fab.Scrub.TokenShapes` | the three shapes are replaced; an asset GUID is not |
| `Hayba.Fab.Texts.EveryCodeHasAText` | every code and reason of section 15 has an entry in `HaybaFabTexts.h` |
| `Hayba.Fab.Texts.PassRedactionUnchanged` | every text of Appendix A passes `HaybaFab::Scrub` and the seam's `RedactTextForLog` unchanged |
| `Hayba.Fab.Attribution.RecordedFolderPlusParentMaterials` | a first Megascans import on 5.8: the mesh, its textures and the parent materials are all imported, although the materials are outside the recorded folder |
| `Hayba.Fab.Attribution.ForeignChangesAreUnattributed` | a change under `/Game/Fab` outside the recorded folder is not imported |
| `Hayba.Fab.Attribution.OtherListingIsInNoArray` | the paths of a second tracked listing are counted, not listed |
| `Hayba.Fab.Attribution.ChangesBeforeClickAreDropped` | they are counted in `changes_before_click` and appear nowhere |
| `Hayba.Fab.Watch.NoExitFromWaitingWithoutClick` | registry changes and cache growth alone change no state and add `activity_without_click` (SC9) |
| `Hayba.Fab.Watch.ClickStartsDownloading` | for the add line and for the drag line; the action is `AcquireLease` |
| `Hayba.Fab.Watch.HeuristicExitOnlyWhenUnverified` | with `bClickEventsVerified` false, changes move to `importing` with `click_not_observed` |
| `Hayba.Fab.Watch.DownloadingToImporting` | by registry changes, and by Interchange becoming active |
| `Hayba.Fab.Watch.SucceedsOnRecordAndSettle` | both conditions are needed |
| `Hayba.Fab.Watch.SettleRestartsOnNewChanges` | a late burst delays success |
| `Hayba.Fab.Watch.EarlyChangesThenLongImportDoesNotSucceedEarly` | early changes, then a long phase with Interchange active and no change: no success, no `unconfirmed`, until Interchange is idle |
| `Hayba.Fab.Watch.SecondListingBlocksSuccess` | one recorded and one pending listing: no success through the record rule; after the grace the job ends, and the primary listing decides the attribution |
| `Hayba.Fab.Watch.PluginInstallIsNotAClick` | the warning, and no state change |
| `Hayba.Fab.Watch.DifferentListingStillSucceeds` | `listing_match: "false"` plus the warning |
| `Hayba.Fab.Watch.PackRuleWithoutRecord` | a new top-level folder, no record, settled for the grace |
| `Hayba.Fab.Watch.MetaHumanWithoutRecord` | the MetaHuman rule, with `unverified_kind` |
| `Hayba.Fab.Watch.UnconfirmedAfterRecordGrace` | `unconfirmed` plus the warning |
| `Hayba.Fab.Watch.AbandonedOnTabClose` | only while waiting, only after the grace, only if a tab was resolved |
| `Hayba.Fab.Watch.TabCloseAfterClickWarnsThenFails` | the warning first; `fab_tab_closed` after the silence |
| `Hayba.Fab.Watch.TwoDeadlines` | the click deadline counts from the start, the import deadline from the click; success on the deadline tick wins |
| `Hayba.Fab.Watch.StallDoesNotTimeOut` | a tick gap longer than the time left moves the deadline; the job goes on |
| `Hayba.Fab.Watch.StallIsNotQuiet` | a tick gap does not complete the settle time |
| `Hayba.Fab.Watch.SizeWarningFiresOnce` | one warning across many ticks above the threshold |
| `Hayba.Fab.Watch.PieStartFlaggedNotActedOn` | the flag is set and the state does not change |
| `Hayba.Fab.Watch.NavigatedAwayWarns` | the warning, once, and no state change |
| `Hayba.Fab.Watch.CancelStopsWatching` | `cancelled` from every non-terminal state, for both reasons |
| `Hayba.Fab.Watch.UnsafeStops` | `failed` with the P0 code |
| `Hayba.Fab.Watch.FailureEvents` | the three failure events |
| `Hayba.Fab.Watch.OpeningFallsBackToSystemBrowser` | the action and the warning after 20 s |
| `Hayba.Fab.Watch.Replay.<kind>.<engine>` | one test per fixture of section 13.1: the replay reaches the expected terminal state with the expected arrays |
| `Hayba.Fab.Sync.SucceedsAfterShortPage` | one short page, and several pages with a short last one |
| `Hayba.Fab.Sync.FullPageWaitsForNextResponse` | no success on a short silence after a full page |
| `Hayba.Fab.Sync.EmptyPageAfterPagesIsEndOfList` | `succeeded`, `end_of_list` |
| `Hayba.Fab.Sync.EmptyFirstPageIsNotAnEmptyLibrary` | `failed`, `missing_results_or_empty_library` |
| `Hayba.Fab.Sync.FailsOnEachErrorEvent` | three reasons |
| `Hayba.Fab.Sync.NotSignedIn` | the code |
| `Hayba.Fab.Sync.NoResponse` | 30 s without an event |

**Handler and pumps, with the fake backend.**

| Test | Asserts |
|---|---|
| `Hayba.Fab.Handler.CommandsRegistered` | exactly the names of the plans built so far; none of the four dead names |
| `Hayba.Fab.Handler.StatusShapes` | three sessions and five unavailable reasons, `fab_disabled` among them |
| `Hayba.Fab.Handler.SessionAmbiguousIsUnknown` | two unnamed platforms that disagree |
| `Hayba.Fab.Handler.ContractChangedReported` | in the status, as a refusal, and as a warning, per the last column of section 5.5 |
| `Hayba.Fab.Handler.OpenRefusalsAndUrl` | every handler code of section 6.2 |
| `Hayba.Fab.Handler.OpenWaitsForIndexRedirect` | no `Navigate` call while the tab shows the local page |
| `Hayba.Fab.Handler.OpenConfirmsNavigation` | `requested`, then `confirmed` in `last_open`; `failed` and the system browser after 20 s |
| `Hayba.Fab.Handler.OpenRefusedWhileWatchWaits` | another listing is refused; the watch's own listing is not |
| `Hayba.Fab.Handler.TabFollowedByWeakPointer` | a background tab stays alive; closing a second tab does not abandon the job |
| `Hayba.Fab.Handler.ImportStartRefusals` | every handler code of section 6.3, including the refused param names and `asset_registry_loading` |
| `Hayba.Fab.Handler.ImportStartNotSignedInIsAWarning` | D-F8 |
| `Hayba.Fab.Handler.ImportStartHoldsNoLease` | no lease call before the click |
| `Hayba.Fab.Handler.ImportJobGeneric` | a scripted glTF timeline ends with the right arrays |
| `Hayba.Fab.Handler.ImportJobMegascansWithParentMaterials` | the parent materials are in `imported_paths` and in `saved_by_fab`, although they are outside the recorded folder; no `paths_outside_record` for them |
| `Hayba.Fab.Handler.ImportJobPack` | a new top-level folder becomes a candidate root; a re-import into an old folder is seen once the record names it |
| `Hayba.Fab.Handler.ImportedPathsLimitedToRecord` | a foreign change under `/Game/Fab` goes to `unattributed_changes` with the warning |
| `Hayba.Fab.Handler.UnsavedAndSavedByFabPartition` | with `evaluated` true, the two subsets are disjoint and cover `imported_paths` |
| `Hayba.Fab.Handler.CoreKeysAlwaysPresent` | the two core keys are arrays in the start reply and in every poll |
| `Hayba.Fab.Handler.TerminalOnlyAfterArraysStored` | while the slices run, `status` is not terminal and `phase` is `finalizing` (SC10) |
| `Hayba.Fab.Handler.StopWithoutBackendIsNotEvaluated` | `evaluated: false`, empty subsets, `partition_not_evaluated` |
| `Hayba.Fab.Handler.ArraysArePaged` | 700 paths: three pages, `counts`, `has_more`, nothing cut |
| `Hayba.Fab.Handler.ResultStoreKeepsEight` | the ninth job expires the first: `arrays_expired`, `counts` kept |
| `Hayba.Fab.Handler.DescribeFromRecord` | folder, page, partition of the page |
| `Hayba.Fab.Handler.DescribeWithoutRecord` | `recorded: false`, empty arrays |
| `Hayba.Fab.Handler.JobStatusUnknownId` | `fab_job_unknown`, also for a build job's id |
| `Hayba.Fab.Handler.JobCancelIsIdempotent` | a second cancel and a cancel after the end |
| `Hayba.Fab.Handler.JobCancelByOtherOwner` | it works, `cancelled_by` is set, and a Warning names both owners |
| `Hayba.Fab.Handler.ResponsesCarryNoTokenShapes` | the fake emits token-shaped notes; no response, progress, output or stored list carries one |
| `Hayba.Fab.Handler.LeaseAcquiredAtClickAndReleased` | acquired on the click, released on each terminal state |
| `Hayba.Fab.Handler.LeaseReacquiredAfterLapse` | after a long tick gap the pump acquires again; with another holder it warns `lease_not_held` |
| `Hayba.Fab.Handler.UnsafeStopsWithoutBackendCalls` | the fake records no call after the flag |
| `Hayba.Fab.Handler.PumpBudget` | a slow fake produces the warning once |
| `Hayba.Fab.Handler.LibraryReadShapeAndPaging` | filters, paging, the zero-GUID row, missing fields as `null` |
| `Hayba.Fab.Handler.LibraryReadAfterFailedSyncIsNotEmptySuccess` | `sync_state: "failed"`, stale items from the snapshot; a second failed sync does not replace the snapshot |
| `Hayba.Fab.Handler.LibrarySyncRefusals` | every handler code of section 6.7, including D-F9 and `fab_sync_too_recent` |
| `Hayba.Fab.Contract.ProbeOnThisEngine` | the real probe returns no missing item on the engine under test, apart from `log_events_verified` |

**With the real lease table.**

| Test | Asserts |
|---|---|
| `Hayba.Fab.Router.StartPieRefusedDuringImportJob` | Real lease table, fake Fab backend. Before the click, `editor_start_pie` from an agent is not refused by the job. After the click it answers `asset_busy`. After the job ends it is free again |

**Core tests, extended or new.**

| Test | Change |
|---|---|
| `Hayba.MCP.Jobs.ProgressAndCancel` (new) | the four new registry functions, bounds, no-ops for Done and unknown jobs |
| `Hayba.MCP.Jobs.BuildStatusShowsProgress` (new) | `build_status` adds `progress` and `cancel_requested` and keeps its old keys |
| `Hayba.MCP.State.PieRule` | the eight Fab names: five Safe, three Refuse |
| `Hayba.MCP.Health.UnsafeGatePolicy` | only the two job commands answer |
| `Hayba.MCP.Lease.ClassificationDrift`, `Hayba.MCP.Lease.ReadClassDrift`, `Hayba.MCP.State.PieSafeDrift`, `Hayba.MCP.Health.AllowlistDrift` | accept a satellite command when its satellite is not loaded; the size pins move (section 5.6); the asset-write pin does not move |
| `Hayba.MCP.Satellite.HostSeam` (new) | C2: a job lease is acquired, renewed and released; `FindAssetLeaseHolder` names the holder; `CallerOwner` is set inside a dispatch and empty outside one; `RunGuarded` records a fault under the test override |
| `Hayba.MCP.Editor.ConsoleRefusesEosAndFabCommands` (new) | C6: each of the six, in lower case, with leading spaces, and as the second segment of a string split at the pipe character |
| `Hayba.MCP.Editor.LogReadersDropEosLines` (new) | C7: a `LogEOSShared` line in the engine's format with an `AccessToken=` value is absent from both readers' replies, and `dropped_lines` counts it |

### 12.3 Node tests

New files, so they do not collide with other lanes.

| File | Asserts |
|---|---|
| `N/src/tools/fab/fab-tools.test.ts` | the seven shapes; the seven description strings; every refusal code becomes a structured result; strict schemas; the refused param names keep their codes; no result names a wire command; a found job is `ok: true` whatever its status |
| `N/src/tools/fab/fab-poll.test.ts` | `wait_s` polling and its end conditions; `editor_busy` for a timeout and for `ECONNREFUSED`, with and without an earlier reply; a start command is sent once even when the transport fails |
| `N/src/tools/fab/fab-redaction.test.ts` | the fake sender emits a JWT-like note, an `eg1~` value and a `Bearer` value in notes, warnings and URLs, and all are scrubbed; every fixed text and every description passes both redactors unchanged |
| `N/src/tools/fab/fab-registry.test.ts` | **the tools of the plans built so far, by exact list** (section 16.2); `hayba_fab_marketplace_search` and `hayba_fab_download` are not registered; the wrappers use only the eight wire names; none of the four dead names is a sidecar key; the two start commands are in `NON_IDEMPOTENT` |
| `N/src/tools/fab/fab-unknown-command.test.ts` | `Unknown command` becomes `fab_satellite_missing`, with the hint that names both causes |
| `N/src/tools/fab/fab-library-list.test.ts` | the nine outcomes of section 7.7 |
| `N/src/tools/fab/fab-contract.test.ts` | source scans that fail closed: the rules of section 11.2; **no dead wire name as a string literal in the satellite**; every declared `fab_*` command has a sidecar entry with `returns` (the layer-2 check for satellite commands); every refusal code is in `KNOWN_UE_CODES` and in `IsWireRefusalCode`; every job error code is in `KNOWN_UE_CODES`; every code the satellite emits starts with `fab_` or is a P0 code; no key of section 6 ends in a secret word |
| `N/src/tools/fab/fab-satellite-modules.test.ts` | every module name in `SatelliteCommands()` is a module of a `.uplugin` under `unreal/` |
| `N/src/security/secret-redaction.test.ts` (extended) | the `eg1~` pattern; asset GUIDs are untouched |
| the P0 drift tests (extended): `access-policy-drift`, `editor-state-policy-drift`, `editor-health-contract`, `asset-busy-drift`, `ue-refusal-codes` | the five Fab names in their sets; the moved size pins; the Fab codes |

All tests use a fake `executeCommand` sender. Tests that wrap a handler for the tool stream mock the TCP client, so nothing dials a real editor.

### 12.4 Running them

- **Scratch host only.** Builds, automation runs and live probes happen on a throwaway project under `D:/UEScratch`, for example `D:/UEScratch/FabHost58/FabHost58.uproject` and `D:/UEScratch/FabHost57/FabHost57.uproject`. Never in an existing project.
- The scratch host's `Plugins/` holds **copies** of `HaybaMCPToolkit` and `HaybaMCPFab` from this worktree, not links.
- The headless run is the one in the P0 spec (section 6.3 there), with the scratch project and the `Hayba` filter. The interactive editor is closed during it.
- **Exact names.** A build can report success without compiling a newly added file. A manifest, `N/scripts/fab-expected-automation-tests.txt`, lists every test of section 12.2, the replay tests by their full names, and the P0 checker `check-automation-report.mjs` fails when a name is missing or not Success.
- Node: `npx tsc --noEmit && npm test && npm run lint:legacy-wrappers`, then `npm run build:server` before any live check.

---

## 13. Live probes

### 13.1 Rules for every probe

**Where and who.**

- A probe runs on a **scratch host only**: 5.8 first, then 5.7. Never in an existing project.
- **A person performs the sign-in and every click.** No probe signs in, clicks, or accepts a licence.
- The person uses free listings they are content to add, one per import kind.
- No other editor with Hayba loaded runs on the machine during a probe. A second editor takes the next port after 52342 (`P/Private/HaybaMCPModule.cpp:430-442`), and a client would talk to the wrong one.

**The probe plugin (D-F18).**

- The probes run from a throwaway plugin, `HaybaFabProbe`. It lives on the branch `probe/fab-recorder`, which never merges. It depends on no Hayba plugin, so the probes need neither the P0 train nor the toolkit.
- It obeys section 11.2. The scan of that section is run on its source by hand before it is built.
- It has five console commands. None takes free text except an id or a label, and an id is checked against the pattern of section 6.2.

| Console command | What it writes |
|---|---|
| `HaybaFabProbe.Contract` | the contract items of section 5.5 |
| `HaybaFabProbe.Session` | the three counts of section 6.1 |
| `HaybaFabProbe.Open <id>` | the steps of section 6.2 as they happen: tab found or created, browser found, ready, requested, confirmed |
| `HaybaFabProbe.Record <label>` and `HaybaFabProbe.Stop` | **one record per tick** to `Saved/HaybaFabProbe/<label>.jsonl` |
| `HaybaFabProbe.Library` | the distinct values of the library's type fields, and counts |

- A one-shot dump cannot show a timeline, which is what P3 to P8 need. The recorder can.
- One record holds exactly what `FInputs` and the driver need: the time, the tick gap, the gather cost in ms, the click ids, the listing type, the event codes, the two counts of unmapped lines, the packages the registry added and updated, whether Interchange is active, the new or changed entries of Fab's record, the cache growth, whether the tab is alive and shows the listing, and whether PIE runs.
- `Stop` adds a final record: for every package seen, whether it is dirty, whether it has a file on disk, and its class.

**Fixtures and replay.**

- A script, `N/scripts/scrub-fab-recording.mjs`, turns a recording into a fixture under `unreal/HaybaMCPFab/Source/HaybaMCPFab/Private/Tests/Fixtures/<kind>.<engine>.jsonl`.
- The fake backend replays a fixture through the real pump and the real machine. That is the test `Hayba.Fab.Watch.Replay.<kind>.<engine>`.
- **The replay test is the pass condition of P3 to P6.** Nobody judges whether a job "would" have succeeded.
- Fixture kinds: `gltf_fbx`, `gltf_fbx_cached`, `megascans_3d_first`, `megascans_3d_second`, `megascans_surface`, `ue_pack_new`, `ue_pack_existing`. Engines: `58`, `57`.
- The read-only recording of P6 and the recordings of P7 and P8 are summarised in the probes file. They are not fixtures.

**What a recording, a fixture and the probes file may hold.** The probes file and the fixtures are committed to a public repository.

- They hold **counts, event codes, booleans, times, class names and `/Game` paths**. They never hold a value that could be a credential.
- No listing title, no seller, no library row id, no account id, no Windows user name, no machine name.
- Paths are `/Game/…` or `<cache>/…`. No path under a user profile.
- URLs are scheme, host and path, without a query.
- The scrub script replaces every listing id with a placeholder id and every name segment that comes from a listing with `Item<N>`, the same way throughout one file. The folder structure stays.
- No probe runs `EOSSDK INFO`.
- Before every commit, the file is searched for the names this repository must not carry and for the shapes of section 11.6.

**After every probe** the scratch host's log is searched for token-shaped strings.

| Where the hit is | What happens |
|---|---|
| a line of a Hayba log category | The probes stop. It is a defect of Hayba and is fixed first |
| a line of any other category | It is recorded as an upstream finding: the category and the count, never the line. The probes go on |

In both cases the person signs out on Fab's page, which ends the session the value belonged to, and the log file is deleted. Only the fact of the hit is written down.

- Each result is written to `docs/superpowers/specs/2026-09-28-fab-tools-probes.md` with the engine version, the Fab version, and the date.

The probe numbers are this spec's own. They are in the order of section 2.4: two prerequisites, then the import kinds by priority, then the rest.

### 13.2 The probes

| # | Probe | What the person does | What is recorded | Pass condition | What it decides |
|---|---|---|---|---|---|
| P1 | **Session states** | Starts the editor fresh. Opens Window > Fab. Signs in if asked. Closes the tab. Signs out in Fab's page. Repeats once with the engine plugin `OnlineSubsystemEOS` enabled | per step: platform count, unnamed platform count, signed-in accounts | After the tab opens with a valid session there is exactly one unnamed platform with one account | Whether `session` can read `signed_in` rather than `unknown`, and the wording of the hint |
| P2 | **Open and navigate** | Runs `Open` with no Fab tab, with one, with two, and with the Fab tab in the background. On 5.8 repeats all four with the experience mode set to performance. Looks at the tab each time | the steps of `Open`; whether **Add to Project** is visible; the same for a search with and without `is_free=1`; whether the system-browser forms show the listing | The listing shows with **Add to Project** in every case, and on 5.7. A background tab reads as alive | Whether `fab_open` works in the editor or falls back. Whether the id pattern is right. How a created tab is captured (V2, V3) |
| P3 | **glTF/FBX import** (priority 1) | Records, then clicks **Add to Project** on a small free glTF or FBX listing. Then on one whose archive is already cached | two recordings | The replays `gltf_fbx` and `gltf_fbx_cached` reach `succeeded` with `fab_recorded`; the landing folder is `/Game/Fab/<Name>`; every package is unsaved | The click line (V16). Whether Fab's recorded id and the id in the click line equal the listing id (V5). Whether Interchange reads as active for both formats (V17) |
| P4 | **Megascans 3D import, with parent materials** (priority 1) | In a **fresh** scratch project, records and adds a Megascans 3D asset. Then a second one | two recordings, with the length of the silent phase between the first registry change and the end of the import | The replays `megascans_3d_first` and `megascans_3d_second` reach `succeeded`. On 5.8 the first import creates and saves the parent materials, and the second does not. On 5.7 neither does | `saved_by_fab`, the parent-materials warnings, SC2, and the settle timers |
| P5 | **Megascans surface import** (priority 2) | Records and adds a Megascans surface | one recording | The replay `megascans_surface` reaches `succeeded`; the record is the parent of the tier folder | Whether surfaces need any rule of their own |
| P6 | **UE pack import** (priority 3, low) | Records and adds a small free pack. Then one whose folder already exists. Then one with a read-only file in the target | three recordings, with whether the files appeared on disk before the registry changed, whether the record's entry is still in the config file afterwards, and any notification that asks for a restart | The replay `ue_pack_new` reaches `succeeded` | `fab_recorded` or `pack_rule` for packs. Whether a re-import into an existing folder is visible at all. The `read_only_files` warning |
| P7 | **Closing the tab during a download** | Records, starts a download of a listing of at least 500 MB, and closes the Fab tab | one recording; whether the import finishes, stops, or the editor faults | No fault | The wording of "keep the Fab tab open", and whether a closed tab should stop the job at once |
| P8 | **Starting PIE during an import** | Records and presses Play during an import | one recording; whether the import finishes, and any fault or conflict | No fault | The wording of the PIE warning. Whether flagging is enough. The interplay with the P0 veto is checked later, in the live ladder |
| P9 | **Library sync** | Signed in, on an account that owns at least six items, runs Fab's sync with a page size of 5 | the log events in order; the row count over time; the time between pages; whether a last empty page arrives | Rows appear, several pages are parsed, and the sync machine replayed on the recording ends `succeeded` | **Whether the library works on 5.8** (section 7.8). The timers of section 9 |
| P10 | **Library values** | Runs `Library` | the distinct values of `listing_type`, `source`, the distribution method and the image type; whether any id is a zero GUID; the form of the URLs (host and path pattern only); whether a row's id equals the id recorded by P3 to P6 (yes or no, never the ids) | Every import kind of section 2.4 can be told apart | The `item_kind` mapping, the `in_project` join, and whether the listing parser accepts the feed's URLs |
| P11 | **Sign-in from a fresh session** | In an editor started outside the launcher, with no saved session, signs in from Fab's page | what the person had to do, and whether another window or program was needed | The person can sign in without Hayba | The text of the `session_not_signed_in` warning and of the `fab_not_signed_in` hint |
| P12 | **Size on the page** | Looks at a listing before clicking | whether the page shows a download size | not a pass or fail | Whether `user_action` can point the person to the size |

### 13.3 What follows from a probe

**When it passes,** its findings go into `HaybaFabVerified.h` for that Fab version: the click line, the id join, the verified kinds, the `item_kind` mapping. The tool descriptions follow from that table (section 7).

**When it fails:**

| Probe | If it fails |
|---|---|
| P1 | `session` stays `unknown` in that configuration; the tools keep working |
| P2 | `fab_open` and the import start use the system browser and the second `user_action` |
| P3, P4 | The kind is not claimed as verified. Plan 3 does not ship until the machine is amended (D-F20) and the replay passes, because SC1 binds for priority 1 on 5.8 |
| P5 | Surfaces are named as unverified in the tool description |
| P6 | Packs are named as unverified, with the limit text of Appendix A.4 |
| P7, P8 | A fault is reported upstream; the warning becomes stronger; nothing else changes, because Hayba cannot prevent either act |
| P9 on 5.8 | The decision rule of section 7.8: plan 4 waits for the maintainer |
| P9 on 5.7 only | The library tool names 5.7 as unverified |
| P10 | `item_kind` stays `unknown` and `in_project.join` stays `unverified` |

---

## 14. Per-engine differences

| Topic | UE 5.7 (Fab 0.0.10) | UE 5.8 (Fab 0.0.17) |
|---|---|---|
| Tab id | one tab, `FabTab`, registered at start-up (`F57/Private/FabBrowser.cpp:59`, `:226-243`) | tabs `Fab1`, `Fab2`, … created on demand (`F58/Private/FabBrowser.cpp:259-264`) |
| Opening a tab | `TryInvokeTab("FabTab")` focuses or spawns (`F57` `:103-113`) | every run of the entry point creates a new tab (`F58` `:134-144`, `:335-382`) |
| Rendering | one off-screen browser | `ExperienceMode`: standard is off-screen and spawns through the global tab manager (`F58` `:457-501`); performance is native and lives in Fab's own tab manager under the host id `FabBrowser.Host` (`F58` `:384-455`), so a global lookup by `Fab<N>` does not find it |
| First page of a new tab | Fab's URL | a local index page that redirects to Fab's URL (section 3.2) |
| No web browser | a modal dialog (`F57` `:284-289`) | an error tab, no modal (`F58` `:280-320`, `:344-348`) |
| Production base URL | `https://www.fab.com` (`F57/Private/FabSettings.cpp:67`) | `https://fab.com` (`F58/Private/FabSettings.cpp:57`) |
| Environments | Prod, Gamedev, Test, CustomUrl, with a `CustomUrl` property (`F57/Private/FabSettings.h:12-18`, `:48-50`) | Prod, Gamedev, Local (`F58/Private/FabSettings.h:12-17`) |
| `Fab.SetEnvironment` | `prod`, `gamedev`, `test` | `prod`, `gamedev`, `local` |
| Navigation guard | in production, a URL outside Fab is sent back and opened in the system browser (`F57/Private/FabBrowser.cpp:308-335`) | Fab web URLs are remapped to `/plugins/ue5/…`; other hosts load normally (`F58/Private/FabBrowser.cpp:1180-1229`) |
| Bridge version | `1.0.0` (`F57/Private/FabBrowserApi.cpp:328`) | `1.1.0` (`F58/Private/FabBrowserApi.cpp:450`) |
| Bridge entry points | `AddToProject` | plus **`InstallToProject`** and `InstallToEngine`, with a plugin install workflow (`F58/Private/FabBrowserApi.h:122-126`, `F58/Private/FabBrowserApi.cpp:213-287`) |
| Click lines | `F57/Private/FabBrowserApi.cpp:50`, `:180` | `F58/Private/FabBrowserApi.cpp:89`, `:301`. The wording is the same |
| Active workflows | one list | one list per tab (section 3.2) |
| Megascans parent materials | stay in the plugin's own content | copied to `/Game/Fab/Materials`, auto-saved, settings rewritten, once per project (`F58/Private/Workflows/QuixelImportWorkflow.cpp:220-312`) |
| Packs | no missing-plugin prompt | a notification with "Enable Missing and Restart" (`F58/Private/Workflows/PackImportWorkflow.cpp:68-195`) |
| Emporium | not checked | Fab skips its start-up (`F58/Private/FabModule.cpp:53-60`) |
| Workflow base class | plain class, raw delegate bindings | `TSharedFromThis`, shared bindings, completion deferred by a frame (`F58/Public/Workflows/FabWorkflow.h:43`, `:82-94`) |
| Closing a tab | the single browser is released 1.5 s later (`F57/Private/FabBrowser.cpp:380-418`) | the tab's bridge is unbound at once and its object is released 1.5 s later (`F58/Private/FabBrowser.cpp:839-938`) |
| Default cache folder | `<user temp>/FabLibrary` (`F57/Private/FabSettings.h:62`) | the same (`F58/Private/FabSettings.h:68`) |
| Library sync source | identical file | identical file |
| Interchange manager | `IsInterchangeActive` and the three delegates are public (`InterchangeManager.h:808`, `:488-490`) | the same (`:841`, `:516-518`) |
| EOS manager | `GetActivePlatforms` at `E57/Public/IEOSSDKManager.h:134`; the `EOSSDK INFO` macro at `E57/Private/EOSSDKManager.cpp:1258` | the same interface at `:134`; the macro at `:1263` |
| `Fab.Build.cs` | no platform-SDK line | sets `bRequiresPlatformSDK = true`. The satellite does not link Fab, so this does not reach it |

What Hayba does differently per engine is confined to `FHaybaFabPluginBackend`: the tab id, how a tab is opened and captured, the wait for the index redirect, the base URL, the 5.7 modal guard, and the parent-materials warning. The handler, the machines and the shapes are the same.

---

## 15. Error handling

### 15.1 Codes

There are three lists of codes and one list of warnings. The last two columns say which sets a code joins.

**List 1: refusals. The command did not run.**

| Code | From | Emitted by | Detail keys | What the caller does | `KNOWN_UE_CODES` | `IsWireRefusalCode` |
|---|---|---|---|---|---|---|
| `editor_unsafe_restart_required` | router, P0 T1 | every command except the two job commands | `editor_health` | stop; the user restarts the editor | P0 | P0 |
| `pie_active` | router, P0 T2 | `fab_open`, `fab_import_watch_start`, `fab_library_sync` | `pie` | wait until `editor_get_state.pie` is `none` | P0 | P0 |
| `lease_conflict` | router, P0 T8 | the same three, when another owner holds the world or everything | `lease` | wait, or acquire | P0 | P0 |
| `owner_required` | router, P0 T8 | the same three | `lease` | send an owner | P0 | P0 |
| `fab_bad_request` | handler | all eight | `param` | fix the call | added | added |
| `fab_invalid_listing` | handler | `fab_open`, `fab_import_watch_start`, `fab_import_describe` | `reason` | pass an id or a Fab listing URL | added | added |
| `fab_target_path_unsupported` | handler | `fab_import_watch_start` | `param` | drop the param; read `fab_location` afterwards | added | added |
| `fab_licence_acceptance_unsupported` | handler | `fab_import_watch_start` | `param` | drop the param; the person accepts on the page | added | added |
| `fab_unavailable` | handler | all but `fab_status` and the two job commands | `reason` | the hint of Appendix A.2 for that reason | added | added |
| `fab_contract_changed` | handler | `fab_open`, `fab_import_watch_start`, `fab_import_describe`, `fab_library_sync`, `fab_library_read` | `missing` | report it; the engine's Fab plugin changed | added | added |
| `fab_not_signed_in` | handler | `fab_library_sync` | `fab_tab_open` | open the Fab tab, let the person sign in, call again | added | added |
| `fab_job_already_running` | handler | `fab_import_watch_start`, `fab_library_sync`, `fab_open` | `active_job_id`, `kind` | follow or cancel that job | added | added |
| `fab_job_unknown` | handler | the two job commands | `job_id` | the editor restarted, or the id is not a Fab job; use `hayba_fab_import_describe` | added | added |
| `fab_sync_too_recent` | handler | `fab_library_sync` | `retry_after_s` | wait that long | added | added |
| `console_command_refused` | core, C6 | `editor_run_console_command` | `command_head` | do not run it | added | added |

- The handler never emits `pie_active`, `lease_conflict` or any other router code. Those are built only by the router's `MakeGateRefusal`, with detail objects the handler cannot fill.
- Reasons of `fab_unavailable`: `fab_disabled`, `emporium`, `commandlet`, `web_browser_unavailable`, `non_production_environment`, `asset_registry_loading`.

**List 2: job errors. The job ran and ended badly.** They appear in `error.code` of a job status, inside a reply that is `ok: true` at the wire.

| Code | Meaning | `KNOWN_UE_CODES` | `IsWireRefusalCode` |
|---|---|---|---|
| `fab_download_failed` | Fab logged a failed download | added | no |
| `fab_import_failed` | Fab logged a failed import, a failed unpack, or no importable files | added | no |
| `fab_import_rejected` | Fab did not handle the asset type. It may refuse the same listing until its tab is reopened | added | no |
| `fab_tab_closed` | the Fab tab was closed after the click and nothing followed | added | no |
| `fab_library_sync_failed` | Fab's library request did not succeed; `reason` says how | added | no |
| `fab_library_sync_no_response` | nothing recognisable was logged within 30 s | added | no |
| `fab_not_signed_in` | Fab found no signed-in account when it started the sync | in list 1 | in list 1 |
| `editor_unsafe_restart_required` | the editor became unsafe during the job | P0 | P0 |
| `fab_satellite_unloaded` | the satellite module shut down | added | no |

A job that ends `timed_out`, `cancelled` or `abandoned` has `error: null`. `timed_out_waiting_for`, `cancel_reason` and `cancelled_by` say why.

**List 3: Node-only codes.** They join neither set; Node makes them.

| Code | Meaning |
|---|---|
| `fab_satellite_missing` | the editor answered `Unknown command` for a `fab_*` command |
| `editor_busy` | every poll failed at the transport while a job was running |
| `transport`, `timeout` | as for every tool |

**Warnings.** The command or job continued. Each is `{ "code", "message" }` in `warnings[]`, with the message of Appendix A.1.

| Group | Codes |
|---|---|
| preflight | `session_not_signed_in`, `fab_contract_changed`, `read_only_files`, `quality_tier_raw`, `megascans_parent_materials_will_be_saved`, `lease_held_by_other` |
| opening | `listing_not_shown_in_editor`, `listing_navigated_away` |
| click | `activity_without_click`, `click_not_observed`, `fab_already_processing`, `plugin_install_not_watched`, `different_listing_imported`, `other_listings_imported` |
| import | `download_stalled`, `fab_tab_closed_during_import`, `pie_started_during_job`, `lease_not_held`, `rar_files_skipped`, `megascans_parent_settings_rewritten`, `megascans_parent_materials_copy_failed` |
| result | `unattributed_import`, `paths_outside_record`, `unverified_kind`, `partition_not_evaluated`, `paths_capped`, `pump_budget_exceeded` |
| library | `rows_skipped_zero_id`, `snapshot_truncated`, `sync_last_page_full` |

Every refusal is `not_started`, with `retry_unchanged_safe` true only for `pie_active`, `lease_conflict`, `fab_job_already_running` and `fab_sync_too_recent`.

### 15.2 Situations

| Situation | Behaviour |
|---|---|
| Fab's import holds the game thread | The pump does not tick and polls fail at the transport. Node reports `editor_busy` and keeps polling. The job resumes when the thread is free, and the stall shift keeps its deadlines and its quiet time honest |
| Fab raises its `.rar` dialog | Everything stops until the person answers. Hayba cannot prevent it. The tool description warns about it. Afterwards the job adds `rar_files_skipped` |
| The editor restarts during a job | The registry and the result store are empty afterwards. `fab_job_status` answers `fab_job_unknown`, with the hint to call `hayba_fab_import_describe` with the listing. On 5.8 a pack import can itself ask for that restart ("Enable Missing and Restart") |
| A backend call faults inside a pump tick | The seam's `RunGuarded` contains it, and P0 T1 records it and marks the editor unsafe. The next tick finishes the job through the unsafe stop, with `evaluated: false` |
| The listing's cache folder is huge or unreadable | `observed.cache_measured: false`. The job loses the size warning and nothing else: the cache is not evidence for any transition on a verified Fab version |
| Fab's record file is half-written | The read is tried again a second later. After `RecordGraceSeconds` of settled time the job ends through a rule without a record |
| Two agents start an import | The second gets `fab_job_already_running`, whoever owns the first |
| An import watch and a library sync at the same time | Both run (D-F12) |
| Another owner holds `asset:/Game/Fab` at the start | The start warns `lease_held_by_other` and goes on |
| Another owner holds it at the click | The job goes on with the warning `lease_not_held`, under every enforcement mode. It never refuses at that point: the import is already running |
| The lease lapses because the game thread stalled longer than its lifetime | The pump acquires again as the first act of its next tick. The command queue is drained by another ticker, so one queued command can run in between (RK15) |
| The person adds a second listing | Section 8.7 |

---

## 16. Sequencing

### 16.1 Order

| Step | What | Depends on | Needs a person |
|---|---|---|---|
| 0 | Write the probe plugin on `probe/fab-recorder` and the scrub script. Build the plugin on the 5.8 scratch host | nothing | no |
| 1 | **Probes P1 to P12 on 5.8.** Scrub the recordings. Commit the fixtures and the probes file on `feat/fab-tools` | step 0 | **yes**: sign-in and every click |
| 2 | **The P0 safety train lands on the trunk.** P0 Deploy A and Deploy B are complete on `main`: T1 to T8 and T10, together with the lease feature they are built on, and with the removal of the four dead Fab registrations (commits `3555081d`, `394a4f00`, `57b832af`) | the P0 spec, sections 7.1 and 7.3 | the maintainer merges |
| 3 | Rebase `feat/fab-tools` onto `main`. Confirm that no file under `N/src/tools/fab/` and no `hayba_fab_` name exists before the first Fab commit. Settle V13. Confirm that ADR-0013 is still free | step 2 | no |
| 4 | **Plans 1 to 5**, in the order of section 16.2 | step 3, and the probes each piece names | plan 5 needs the probes on 5.7 |
| 5 | Live ladder on 5.8, then 5.7 (section 16.3) | step 4 | yes |
| 6 | ADR-0013, "Fab: drive, do not impersonate". Changelog, `docs/ARCHITECTURE.md`, `CONTEXT.md`, `CONTRIBUTING.md:40` | step 5 | no |

- Steps 0 and 1 do not wait for step 2. The results that could overturn the design (P2, P3, P4, and P9 on 5.8) therefore arrive first.
- ADR-0011 and ADR-0012 belong to the P0 train. ADR-0013 is the next number.

### 16.2 The five plans

This spec is five implementation plans. Each plan is written, built and merged by itself.

| Plan | Contains | Probes it consumes | Gate |
|---|---|---|---|
| **1. Core seams and log hygiene** | B1 | none | step 3. No Fab, no person. A full rebuild |
| **2. Satellite skeleton, status, open** | B2, B3 | P1, P2, P11, P12 | plan 1 |
| **3. Import watch** (the first consumer's deliverable) | B4, B5, B6, B7, B8 | P3 to P8 | plan 2 |
| **4. Library** | B9 | P9, P10 | plan 3, and the decision rule of section 7.8. It may be dropped |
| **5. UE 5.7 verification** | the 5.7 scratch host, the probes on 5.7, the `.57` fixtures, the live ladder on 5.7 | P1 to P12 on 5.7 | the matching plan on 5.8 |

The library cannot block the imports: it comes after them.

**Build order, with the probes between the pieces.**

| # | Piece | Plan | Tools after it | Needs the result of |
|---|---|---|---|---|
| B1 | Core companion changes C1 to C7, with the core tests of section 12.2 and the extended drift tests | 1 | none | nothing |
| B2 | The satellite skeleton, feature detection, `HaybaFabVerified.h`, `fab_status`, `hayba_fab_login_status`, `fab_satellite_missing` | 2 | 1 | P1, P11 |
| B3 | `fab_open`, `hayba_fab_open` | 2 | 2 | P2, P12 |
| B4 | The watch machine, its pure tests, the fake backend, the replay harness | 3 | 2 | nothing: the machine of section 8 is written as specified, and the replays then judge it |
| B5 | `fab_import_watch_start`, the two job commands, the result store, the three job tools. **glTF/FBX and Megascans 3D** | 3 | 5 | P3, P4: their four replay tests pass |
| B6 | `fab_import_describe`, `hayba_fab_import_describe` | 3 | 6 | P3 (V5) |
| B7 | **Megascans surfaces:** the P5 replay test, plus any rule P5 requires, as an amendment | 3 | 6 | P5 |
| B8 | **UE packs:** the pack rule, the top-level-folder roots, the two pack replay tests, the limit text; then the wording from P7 and P8 | 3 | 6 | P6, P7, P8 |
| B9 | The sync machine, the two library commands, `hayba_fab_library_list` | 4 | 7 | P9, P10 |

- Each piece goes through all five layers before the next one starts.
- Each lands as one or more commits that build and pass both suites on their own.
- `fab-registry.test.ts` and `Hayba.Fab.Handler.CommandsRegistered` assert the exact list of the pieces built so far, which is the "tools after it" column.

### 16.3 The live ladder

On the scratch host, after the automation and Node suites are green:

1. `ping`, then `hayba_fab_login_status`.
2. Disable the engine's Fab plugin in the `.uproject` and restart. Confirm that Fab stays disabled, that the core and the satellite load without a dialog, and that every Fab tool answers `fab_unavailable` with `fab_disabled` (SC6, V10). Enable it again. Then remove the satellite and confirm `fab_satellite_missing`.
3. `hayba_fab_open` with a listing, and with a query. Confirm `last_open.navigation` is `confirmed`.
4. `hayba_fab_add_to_project` for each import kind in priority order. The person clicks. Compare the result with the Content Browser listing of the candidate roots before and after, and with a diff of the `Content` folder on disk (SC1, SC2).
5. During an import: confirm that an agent's `editor_start_pie` answers `asset_busy`, and that the person's Play button needs a second press. Outside an import: start PIE by hand and confirm the three `pie_active` refusals.
6. Restart the editor and confirm that `hayba_fab_import_describe` returns the import of step 4.
7. `hayba_fab_library_list` with `refresh`, if plan 4 was built.
8. Search the log for token-shaped strings, by the rule of section 13.1 (SC3). Confirm that no job reported `pump_budget_exceeded` (SC4).

### 16.4 The parallel lane

This work runs in parallel with the blueprint bulk builder's C++ lane. The two lanes share four Node files and no C++ file.

| Shared file | Rule |
|---|---|
| `N/src/legacy-commands/sidecar.json` | the Fab entries are one appended block |
| `N/src/tools/index.ts` | one hunk: the Fab descriptor block and the `inferDir` rule |
| `N/src/tools/tool-executor.ts` | one hunk each for the codes and for `NON_IDEMPOTENT` |
| `N/src/tools/routing/packs.yaml` | one line per tool in the connectors pack |

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
| RK1 | **The 5.8 library sync may be broken upstream.** Fab 5.8 sends the request to `https://fab.com`; 5.7 sends it to `https://www.fab.com`. If the bare host answers with a redirect, a client that follows it may drop the authorization header, and the request fails. This is inferred from the two base URLs in the engine source and is unverified. Probe P9 decides | The library would be unavailable on 5.8, the first consumer's engine | The decision rule of section 7.8: plan 4 is not built on a failed P9 without a maintainer decision. If it is built and the sync fails, `hayba_fab_library_list` answers by the table of section 7.7 and adds `upstream_suspected: true`. That flag is set when the engine is 5.8 or later **and** the reason is `request_failed_or_not_json`. It never reports an empty library. The other six tools are unaffected |
| RK2 | Fab's private names change: settings properties, column structs, the console command, log wording | A tool degrades or stops | Feature detection reports `fab_contract_changed`. The machines fail closed on unknown log wording. An unknown Fab version has no verified click line, so the job says `click_not_observed`. `Hayba.Fab.Contract.ProbeOnThisEngine` catches missing names at build time per engine |
| RK3 | A failed library refresh empties the table, because Fab removes every row first | The previous list is lost | The in-memory snapshot serves it with `stale: true`. A snapshot is replaced only after a sync that succeeded |
| RK4 | The job attributes someone else's changes to the import: another agent, a source-control sync, the person's own edit | Wrong `imported_paths` | No exit from waiting without Fab's click line. `imported_paths` is limited to the folder Fab recorded; every other change is in `unattributed_changes`. `attribution` says how strong the evidence is |
| RK5 | Closing the Fab tab during a download, or starting PIE during an import, faults the editor | A lost session | Probes P7 and P8. Hayba warns up front and flags. It cannot prevent either act |
| RK6 | Fab's modal dialog, or a long import, holds the game thread | Every lane stalls | `editor_busy` in Node; the stall shift in the machines; the description warns; nothing in Hayba opens a modal |
| RK7 | The job lease blocks other work while an import runs: every agent's `editor_start_pie` and `editor_save_all_and_quit`, the person's Play button (one extra press), and other owners' `python_run` without declared resources | An agent waits | The lease is held only from the click to the end, at most `timeout_s`. `hayba_fab_job_cancel` releases at once, for any caller. A tab that closed ends the job after 120 s of silence |
| RK8 | Measuring a cache folder costs time | Hitches | The walk runs on the thread pool, covers one listing's folder, and stops after 20,000 entries. The pump only reads the result |
| RK9 | A satellite in a development host is a link to another checkout, so a branch's satellite is never the one that runs | Green tests for the wrong code | The scratch host holds copies |
| RK10 | A build reports success without the new files | A test that never ran reports green | The exact-name manifest |
| RK11 | Re-importing into a folder that already exists produces no registry additions, and maybe no updates | `timed_out` although Fab finished | Registry updates are watched too, over all of `/Game`. Probe P6 decides whether that is enough. Until then packs are named as unverified |
| RK12 | Fab's or the EOS log carries sensitive text | A leak through a capture | Event codes only; both EOS categories dropped by the core's log readers; both redaction layers; the log search after every probe |
| RK13 | The P0 names used here change during P0's implementation | This spec goes stale | Section 3.3 is the single list to update; V13 is settled at step 3; the contract test fails when a code is missing on either side |
| RK14 | Installing the satellite enables `EOSShared`, also in a project that disabled Fab | An engine plugin loads that the project did not ask for | Stated in the plugin description, the changelog and the install notes. `EOSShared` creates no platform and signs nobody in by itself. A project that must not load it does not install the satellite. The maintainer may choose `EnabledByDefault: false` instead (section 20) |
| RK15 | Before the click the job holds no lease, and after a stall longer than the lease's lifetime it may have lapsed | PIE can start while the person is about to click, or in the tick before the pump acquires again | The job flags `pie_started_during_job`. Probe P8 shows what Fab does then. The lifetime is up to 900 s, so a lapse needs a block of that length |

---

## 18. Open verifications

These were not settled by reading source. Each has an owner step.

| # | Question | Settled by |
|---|---|---|
| V1 | Does a query over rows that have a column found at run time, with its data read through `GetColumnData(Row, UScriptStruct*)`, build and work on both engines? | B9, on both scratch hosts |
| V2 | Can a tool-menu entry's action be run from code on 5.8 without opening the menu, and do the tab manager's delegates name the tab it creates? | P2, B3 |
| V3 | Is a background tab, or a tab in Fab's own tab manager, found by the lookup of section 6.2, and does its weak pointer stay valid while it is in the background? | P2 |
| V4 | Are listing ids always GUIDs with hyphens? | P2, P3 |
| V5 | Is the id in Fab's click line the listing id? Is Fab's recorded id the same? Is it the library row's id? | P3, P4, P10 |
| V6 | Does the registry report additions for a pack after Fab's scan, and updates for a re-import? Does the pack's record entry survive? | P6 |
| V7 | Are the packages of an Interchange import dirty when the import ends? | P3, P4 |
| V8 | Is there exactly one unnamed EOS platform in a plain project? | P1 |
| V9 | Does the search URL of section 6.2 show results in the plugin's page? | P2 |
| V10 | With Fab disabled in the `.uproject`, does the satellite load without a dialog, and does Fab stay disabled? If a dialog shows, the install notes say to disable `HaybaMCPFab` in that project too, and SC6 is restated for that order | live ladder step 2 |
| V11 | Does the recorded-id config section have the name and the form this spec assumes, and where does the editor write it? | P3 |
| V12 | Is calling EOS account counts on Fab's platform safe before any Fab tab has opened? | P1 |
| V13 | Do the P0 command-set, refusal-set and lease-table names match this spec once P0 is implemented? | step 3 of section 16.1 |
| V14 | Does loading a `/plugins/ue5/…` URL directly behave the same as the remapped web URL on 5.8? | P2 |
| V15 | Do the sidecar tests accept an entry with `agent_callable: false` and `has_ts_wrapper: true`? If not, the eight entries use `agent_callable: true`, as the 44 wrapped commands do today; the editor-side refusals and the no-retry rule hold either way | B2 |
| V16 | Does the click line appear in the log for a cached asset and for a fresh one, before any registry change? | P3, P4 |
| V17 | Does `IsInterchangeActive()` read true for the whole import, for glTF and for FBX, and how long is the silent phase of a first Megascans import? | P3, P4 |
| V18 | Does Fab's library service send a last empty page, and how long do pages take? | P9 |

---

## 19. Files

**New.**

- `unreal/HaybaMCPFab/` (section 5.1), including `Private/Tests/Fixtures/`
- `P/Public/HaybaMCPSatelliteHost.h` and its implementation
- `N/src/tools/fab/fab-shapes.ts`, `fab-poll.ts`, `fab-scrub.ts`, `fab-texts.ts`, `login-status.ts`, `open.ts`, `add-to-project.ts`, `import-describe.ts`, `job-status.ts`, `job-cancel.ts`, `library-list.ts`
- the Node tests of section 12.3
- `N/scripts/fab-expected-automation-tests.txt`
- `N/scripts/scrub-fab-recording.mjs`
- `docs/adr/0013-fab-drive-do-not-impersonate.md`
- `docs/superpowers/specs/2026-09-28-fab-tools-probes.md`, written by the probes

**On the probe branch only, never merged.**

- `unreal/HaybaFabProbe/`

**Moved.**

- `P/Private/HaybaMCPJobRegistry.h` to `P/Public/HaybaMCPJobRegistry.h`

**Modified, C++.**

- `P/Private/HaybaMCPJobRegistry.cpp`
- `P/Private/handlers/HaybaMCPBuildHandler.cpp` (`build_status`)
- `P/Private/handlers/HaybaMCPEditorHandler.cpp` (C6, C7)
- `P/Private/HaybaMCPCommandHandler.cpp` (`IsWireRefusalCode`)
- `P/Private/HaybaMCPCommandSets.h` (after P0)
- `P/Private/HaybaMCPSecretRedaction.cpp` (C5)
- the P0 drift tests in `P/Private/Tests/`, with their size pins

`P/Private/HaybaMCPAccessPolicy.h` is **not** modified (D-F16).

**Modified, Node.**

- `N/src/legacy-commands/sidecar.json`
- `N/src/tools/index.ts`
- `N/src/tools/tool-executor.ts`
- `N/src/tools/routing/packs.yaml`
- `N/src/security/secret-redaction.ts` and its test
- `N/src/tools/no-stub-wrappers.test.ts`
- `N/src/tools/__tests__/wire-command-names.test.ts`
- `N/src/tools/__tests__/access-policy-drift.test.ts`, `editor-state-policy-drift.test.ts`, `editor-health-contract.test.ts`, `asset-busy-drift.test.ts`, `ue-refusal-codes.test.ts` (after P0; the paths are settled with V13)

**Modified, docs.**

- `CHANGELOG.md`, `N/CHANGELOG.md`, with a separate entry for C6 and C7
- `docs/ARCHITECTURE.md` (the satellite section), `CONTEXT.md`, `CONTRIBUTING.md`

---

## 20. What needs the maintainer

**Decisions.**

| # | Decision | Default in this spec |
|---|---|---|
| M1 | `hayba_fab_import_describe` is a seventh tool that the approval of 2026-09-28 did not name. It reads only, and it is what makes a result survive an editor restart | built, as piece B6. Striking it removes B6 and limit L13's second sentence, and nothing else |
| M2 | When the lease is held | from the click to the end (D-F6). The alternative is from the start, bounded by `click_timeout_s` |
| M3 | `EnabledByDefault` of the satellite, given RK14 | `true`, as for the other satellites |
| M4 | The library tool when P9 fails on 5.8 | not built until decided (section 7.8) |
| M5 | C6 and C7 change two existing tools for every user | shipped in plan 1 with their own changelog entry |
| M6 | Stage 2 | not approved; nothing in this spec prepares it |

**Steps that need a person.**

| Step | What the person does |
|---|---|
| Probes P1 to P12 on 5.8, then on 5.7 | signs in on Fab's page, clicks **Add to Project** on free listings, closes a tab, presses Play, and looks at pages (section 13.2) |
| P9 | uses an account that owns at least six items |
| After a probe with a token-shaped hit | signs out on Fab's page and deletes the log file |
| Step 2 of section 16.1 | merges the P0 train into `main` |
| The live ladder | clicks, presses Play twice, restarts the editor (section 16.3) |

---

## Appendix A. Fixed texts

Every text below is a constant in `HaybaFabTexts.h` and in `fab-texts.ts`. A test passes each through both redactors and expects it unchanged. `{…}` marks a value that is filled in.

Four texts may be reworded by a probe. Each has the default below until then.

| Text | Probe |
|---|---|
| `fab_tab_closed_during_import`, and the last sentence of the first `user_action` | P7 |
| `pie_started_during_job` | P8 |
| `session_not_signed_in`, and the hint of `fab_not_signed_in` | P11 |
| the first `user_action` | P12 |

### A.1 Warnings

| Code | Message |
|---|---|
| `session_not_signed_in` | Fab reads as not signed in. Fab signs in when its tab opens. If the page asks, the person signs in there. |
| `fab_contract_changed` | The engine's Fab plugin differs from what Hayba expects. The missing items are listed, and the result is less certain. |
| `read_only_files` | Some files under Content/Fab are read-only. An import that writes there can fail or leave packages unsaved. Hayba changed nothing. |
| `quality_tier_raw` | Fab's preferred quality is Raw. Downloads at this tier can be very large, and Hayba cannot know the size before the click. |
| `megascans_parent_materials_will_be_saved` | If this listing is a Megascans asset, Fab will copy its parent materials to /Game/Fab/Materials and save them by itself, because that folder does not exist yet. |
| `megascans_parent_settings_rewritten` | Fab copied its Megascans parent materials and rewrote its Megascans parent settings. The settings are a config file, not a package, so they are in no list. |
| `megascans_parent_materials_copy_failed` | Fab reported that copying its Megascans parent materials failed. Imported materials may have no parent. |
| `lease_held_by_other` | Another owner holds asset:/Game/Fab. An import that the person starts will still write there. |
| `lease_not_held` | Hayba could not hold asset:/Game/Fab for this job, so other agents are not told that an import is running. |
| `listing_not_shown_in_editor` | The listing could not be shown in Fab's tab. It was opened in the system browser, but Add to Project works only in the editor's Fab tab. |
| `listing_navigated_away` | Fab's tab no longer shows the requested listing. |
| `activity_without_click` | Assets changed before any Add to Project click was seen. Those changes are not part of this import. |
| `click_not_observed` | The log lines of this Fab version are not verified, so the job cannot see the click. It follows asset changes instead, and the result is less certain. |
| `fab_already_processing` | Fab ignored a click because it is already working on this listing. |
| `plugin_install_not_watched` | The person installed a plugin listing. Fab installs plugins outside /Game, and Hayba does not watch that. |
| `different_listing_imported` | The person added a different listing from the one requested. The result describes what was added. |
| `other_listings_imported` | The person added more than one listing during this watch. The others are in other_listings. |
| `download_stalled` | Nothing has changed for {stall_s} s since the click. Fab may still be downloading. Look at Fab's notification. |
| `fab_tab_closed_during_import` | The Fab tab was closed after the click. Fab may not finish this import. |
| `pie_started_during_job` | Play In Editor started while the import was running. Hayba did not stop or pause anything. |
| `rar_files_skipped` | This listing holds .rar files, which Fab cannot unpack. Fab skipped them, so some content was not imported. |
| `unattributed_import` | Assets changed after the click, but Fab recorded no folder for this listing. The paths are a best guess. |
| `paths_outside_record` | Some assets changed outside the folder Fab recorded. They are in unattributed_changes, not in imported_paths. |
| `unverified_kind` | This kind of listing is not verified. Check the result by hand. |
| `partition_not_evaluated` | The job stopped before Hayba could check which packages are unsaved. unsaved_packages is empty because it was not computed, not because everything is saved. |
| `paths_capped` | More than 65536 packages changed. The lists are incomplete. The counts and imported_roots are complete. |
| `pump_budget_exceeded` | A tick of this Fab job took more than 5 ms of editor time. |
| `rows_skipped_zero_id` | Some library rows had no id and were skipped. |
| `snapshot_truncated` | The library has more than 5000 rows. The list that is kept for a failed refresh holds the first 5000. |
| `sync_last_page_full` | The last page was full and no further page arrived. The list may be incomplete. |
| `size_warning.message` | More than {threshold_bytes} bytes were written to Fab's cache for this listing. The figure includes unpacked archives, so it is an upper bound on the download. |

### A.2 Hints of `fab_unavailable`, by reason

| Reason | Cause, for the `error` string | Hint |
|---|---|---|
| `fab_disabled` | the engine's Fab plugin is disabled in this project. | Enable the Fab plugin (Edit > Plugins > Fab), restart the editor, then call again. |
| `emporium` | the Emporium plugin is enabled, so Fab does not start. | The Fab tools cannot work in this project while Emporium is enabled. |
| `commandlet` | this process is a commandlet, and Fab does not start in one. | Use the interactive editor. |
| `web_browser_unavailable` | the editor's web browser cannot start, so Fab's tab cannot show a page. | Enable the Web Browser plugin (Edit > Plugins), restart the editor, then call again. |
| `non_production_environment` | Fab is set to an environment other than production. | The Fab tools work only with production. Set Fab back to production in its settings. |
| `asset_registry_loading` | the editor is still loading its asset list. | Wait until it has finished, then call again. |

### A.3 Hints of the other refusals

| Code | Cause, for the `error` string | Hint |
|---|---|---|
| `fab_bad_request` | the param {param} is unknown, missing or out of range. | Fix that param. The tool's schema lists the allowed keys. |
| `fab_invalid_listing` | the listing is neither a listing id nor a Fab listing URL. | Pass a listing id, or a https://www.fab.com/listings/<id> URL. |
| `fab_target_path_unsupported` | the caller cannot choose the target folder. | Drop this param. Fab chooses the folder. Read fab_location in the result. |
| `fab_licence_acceptance_unsupported` | Hayba accepts no licence. | Drop this param. Only the person accepts a licence, on Fab's page. |
| `fab_contract_changed` | the engine's Fab plugin lacks {missing}. | The engine's Fab plugin changed. Report the items in missing. |
| `fab_not_signed_in` | Fab has no signed-in session. | Open the Fab tab so that Fab can sign in, let the person sign in if the page asks, then call again. |
| `fab_job_already_running` | a Fab job of this kind is running, or an import watch waits for a click on another listing. | Follow the job in active_job_id with hayba_fab_job_status, or stop it with hayba_fab_job_cancel. |
| `fab_job_unknown` | no Fab job has the id {job_id}. | Job ids do not survive an editor restart. To read an import, call hayba_fab_import_describe with the listing. |
| `fab_sync_too_recent` | the last library sync started less than 60 s ago. | Wait {retry_after_s} s, or read the list without refresh. |
| `console_command_refused` | Hayba does not run the console command {command_head}. | Use the Fab tools for Fab. The person can run the command in the editor's own console. |
| `fab_satellite_missing` (Node) | the editor does not know this command. | The HaybaMCPFab plugin is not installed in this project, or the editor is still starting. Try once more. If it still fails, install the plugin. |
| `editor_busy` (Node) | the editor did not answer. | Fab's import may hold the editor. The job goes on. Call hayba_fab_job_status again. |

### A.4 Notes of a job

| When | Note |
|---|---|
| `timed_out`, waiting for `click` | No Add to Project click was seen. If this listing is a plugin, Hayba does not watch plugin installs. |
| `timed_out`, waiting for `import` | The import did not settle in time. Fab may still be working, or it may have stopped without a line Hayba knows. Call hayba_fab_import_describe later. |
| `timed_out`, waiting for `import`, with `unrecognised_error_lines` above 0 | Fab logged errors that Hayba does not know. Fab may refuse this listing until its tab is reopened. |
| `fab_import_rejected` | Fab did not handle this asset type. Fab may refuse this listing until its tab is reopened. |
| `abandoned` | The Fab tab was closed before any click. |
| `fab_tab_closed` | The Fab tab was closed after the click and nothing followed for {silence_s} s. |
| the pack limit, while packs are unverified | Packs are not verified. A pack that lands in a folder that already exists may not be seen. |
| `fab_import_describe` with `recorded: false` | Fab has no record of this listing in this project. MetaHumans are never recorded, and a pack's record can be missing. |
| `fab_job_cancel` | Hayba stopped watching. Fab's own download or import continues; cancel it from Fab's notification. |
| `fab_job_cancel` on a finished job | The job had already finished. |
| `fab_library_sync_failed` with `upstream_suspected` | Fab's own library request failed. It is Fab's request, not Hayba's, and Hayba cannot repair or replace it. The library is still visible in the Fab tab; call hayba_fab_open. |
| `fab_library_sync_failed`, reason `missing_results_or_empty_library` | Fab stored no rows. Fab logs the same line for an error and for an empty library, so Hayba cannot tell which it was. |

### A.5 `user_action`

| When | Text |
|---|---|
| the listing is shown in Fab's tab | In the Fab tab: sign in if the page asks, read the licence, then click Add to Project. Keep the Fab tab open until the import finishes. |
| the listing went to the system browser | Open Window > Fab in the editor, find this listing, read the licence, then click Add to Project. The listing was also opened in your browser. |

### A.6 `next`

| When | Text |
|---|---|
| `evaluated` is true | Save only the packages you choose from unsaved_packages. Hayba saved nothing. |
| `evaluated` is false | Hayba could not check what is unsaved. Call hayba_fab_import_describe with the listing. Hayba saved nothing. |

### A.7 `fab_status.hint`

| When | Text |
|---|---|
| `session` is not `signed_in` | Fab signs in when its tab opens. Open Window > Fab, or call hayba_fab_open. |
| Fab is unavailable | the hint of A.2 for the reason |
| otherwise | none |

### A.8 Messages of job errors

| Code | Reason | Message |
|---|---|---|
| `fab_download_failed` | none | Fab reported that the download failed. |
| `fab_import_failed` | none | Fab reported that the import failed. |
| `fab_import_rejected` | none | Fab did not handle this asset type. |
| `fab_tab_closed` | none | The Fab tab was closed after the click, and nothing followed. |
| `fab_library_sync_failed` | `request_failed_or_not_json` | Fab's library request failed, or its answer was not JSON. |
| `fab_library_sync_failed` | `invalid_json` | Fab could not read the answer to its library request. |
| `fab_library_sync_failed` | `missing_results_or_empty_library` | Fab stored no rows. |
| `fab_library_sync_failed` | `storage_unavailable` | The editor's data storage was not available to Fab. |
| `fab_library_sync_failed` | `timed_out` | The library sync did not finish in time. |
| `fab_library_sync_failed` | `cancelled` | The library sync was cancelled. |
| `fab_library_sync_no_response` | none | Fab logged nothing that Hayba knows within 30 s. |
| `fab_not_signed_in` | none | Fab found no signed-in account when it started the sync. |
| `editor_unsafe_restart_required` | none | The editor became unsafe during the job. |
| `fab_satellite_unloaded` | none | The Fab satellite was unloaded while the job ran. |

---

## Appendix B. Review round 1

Two reviews of the first version produced 23 design findings (F1 to F23), 10 public-safety findings (PS1 to PS10), 17 contradictions (RC1 to RC17), 5 placeholders (PL1 to PL5), 11 ambiguities (RA1 to RA11), a scope split and a non-goal audit. The letters RC and RA are used here so that they cannot be mistaken for the core changes C1 to C7 or for Appendix A. Every finding not listed below was merged as proposed.

| Finding | What was done | Reason |
|---|---|---|
| F6, the proposed fix for the lease claim (send `resources` on the envelope) | Rejected. The problem was accepted and solved by D-F16 | P0 reads declared `resources` from the params, and only for `python_run`. The proposal would give the command no claim. The rest of F6 was merged |
| RC13, a second row type in `AssetWriteCommands` | Rejected, in favour of D-F16 | It changes the type of a table that P0 pins, for one command. The note on lower-cased keys and the missing drift test were merged |
| RA2, refuse on a lease conflict under the enforced modes | Rejected | The handler emits no router code (F12). The lease is acquired at the click, where the import already runs and a refusal has no meaning. One reading is stated in section 15.2 |
| RA10, the detail shape of handler-emitted `pie_active` and `lease_conflict` | Not applicable | F12 removed both. The rest of RA10 was merged |
| RC6, the probe command inside the satellite behind a compile flag | Rejected, in favour of F21 | A separate plugin needs neither P0 nor the toolkit, and no static check needs an exemption. The interleaved order and the "hypothesis" rule were merged |
| RC16, an incremental cache walk on the game thread | Replaced by F14 | The walk runs on the thread pool. The restated SC4 was merged |
| RC17, a fallback for a satellite that Fab's state disables | Not applicable | After F5 the satellite does not depend on Fab. V10 was restated and has a fallback |
| F17, persist each job's progress to disk and answer `interrupted` after a restart | Rejected | The caller holds the listing from the start reply, and `fab_import_describe` reads the result. A file write per progress record costs game-thread time for no new information. The rest of F17 was merged |
| F16, the variant that writes the lists to a file | Not taken | F16 offered paging or a file. Paging was chosen |
| RC1, "on a cut list the caller saves by `imported_roots`" | Merged in part | With paging nothing is cut. Only `paths_capped` remains, and F3 made `imported_roots` informational. Section 6.5 states the trade |
| RA9, a baseline of every asset under the watch roots | Rejected | The preflight refuses while the registry loads, and `imported_paths` is limited to attributed folders. The refusal was merged |
| F11, the variant that keeps the early lease | Not taken | F11 offered two variants. The lease at the click was chosen (M2) |
| F13, a terminal state `empty_or_failed` | Merged in the form of RC10 | One `failed` state with the reason `missing_results_or_empty_library` carries the same information |
| RA8, a 30 s wait after a full page | Merged with the value of F13 | 60 s, the longer of the two |
| F5, "consider `EnabledByDefault: false`" | Not taken; raised as M3 | It is the form of the other satellites. RK14 states the cost |
| F12, the three renamed codes | Merged and extended | Every handler code now starts with `fab_`, so one rule covers them and a test can assert it |
