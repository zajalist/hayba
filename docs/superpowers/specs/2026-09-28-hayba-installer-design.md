# Hayba Installer — Design

**Date:** 2026-09-28
**Status:** Approved design (maintainer "go", 2026-09-28); awaiting the implementation plan
**Branch / base:** `feat/installer` from `origin/main` at `dc6b4403`
**Scope:** Windows only. Public copy says "Unreal Engine 5.7+".

All `file:line` citations refer to `dc6b4403` unless another branch is named. Facts checked on the build host are marked *(checked on build host)*. Claims that still need a live check are marked *(unverified)* and are listed in §16.

---

## 1. Summary

Installing Hayba today takes 9 steps and needs Git, Node, Visual Studio, and admin rights or Developer Mode: clone, `npm install`, build, symlink the plugin into the project, regenerate project files, compile, then edit every AI client's JSON by hand. This design replaces that with **one command** now and **three clicks** later:

- **One setup core.** `hayba-setup.mjs` is a dependency-free Node ESM program. It runs on a bundled, unmodified Node 24 LTS `node.exe`, and it does all the work: preflight, per-user runtime install, engine and project detection, plugin copy, AI client registration, doctor, manifest, uninstall and update.
- **Front door B (ships first, for testers).** `irm https://hayba.vercel.app/install.ps1 | iex` downloads the release payload, verifies its SHA256, and runs the core with defaults.
- **Front door A (later, for the public).** `HaybaSetup.exe` is a per-user Inno Setup installer with one page. It carries the same payload and runs the same core. It needs a code-signing certificate.
- **In the editor.** A "Connect AI client" command reuses the core to register clients, and an update notice reads `latest.json`.
- **Release pipeline.** A self-hosted builder compiles the plugins for each engine from one commit, stages the runtime, and publishes GitHub Release assets with `SHA256SUMS` and `latest.json`.
- **Plugin and server gap fixes first.** Ten small fixes (§10), plus one proposed fix, make the prebuilt binaries installable.

---

## 2. Goals, non-goals, success criteria

### 2.1 Goals

1. **1 command** (tester beta) or **3 clicks** (signed public installer) from nothing to a working install.
2. **No Visual Studio** to open the editor, **no admin**, **no symlink**, **no system Node**, **no Git**.
3. **Configures AI clients automatically.** Claude Code, Claude Desktop, Cursor and VS Code are pre-ticked when detected.
4. **Safe on real machines.** Never touch a developer's symlinked or junctioned plugin. Never overwrite read-only (source-controlled) files. Back up before replacing. Record every write in a manifest so uninstall is exact.
5. **Re-runnable.** Running the installer again is the upgrade path and the repair path. It is idempotent.
6. **Diagnosable.** `doctor` runs at the end of every install and on demand. It prints a report the user can paste into an issue.

### 2.2 Non-goals for v1

- The Python visual add-on (port 7822 on the brain-client branch; torch; 1–2 GB of weights).
- Pro sign-in. v1 is bring-your-own-key only. The one related item in v1 is the `HAYBA_BRAIN_URL` passthrough gap fix (G6), which the installer does not set.
- A Fab listing (Q5), an npm CLI, and a `.mcpb` bundle.
- macOS and Linux. Windows on ARM64.
- Engines built from source. Detection refuses them and links to the build-from-source guide.
- A silent background self-updater (Q6: opt-in, later).
- Automatic registration of Windsurf/Devin and Codex (next release).

### 2.3 Success criteria

| # | Criterion | How it is checked |
|---|---|---|
| SC1 | A clean Windows 11 user account with a Launcher engine (5.8, and 5.7 per Q2) and no Node, Git or Visual Studio runs the one-liner. It finishes with doctor all-pass. Opening the project loads Hayba with no rebuild prompt. The chat panel connects, and Claude Code lists `hayba` as connected. | Load tests L1 and L8 (§9.6) |
| SC2 | No UAC prompt, and no link created. Files are written only under: the runtime dir, the data dir, the selected projects' `Plugins/` and `Saved/HaybaSetup/`, the selected client config files, and `HKCU\Software\Hayba` (plus the uninstall key for the one-liner path). | File-system and registry diff before and after, in L1 |
| SC3 | Re-running the same version exits 0. Client config files stay byte-identical, and plugin copies are left in place (their tree hash matches). | L5, plus unit tests |
| SC4 | Uninstall removes exactly the manifest's paths and our `hayba` client entries. Other client entries and unrelated plugins stay byte-identical. User data is kept unless `--remove-data` is given. | L6, plus unit tests |
| SC5 | Signed exe: 3 clicks from the download page to installed (Download, open, Install). The finish page only reports. | Manual check before the public launch |
| SC6 | Every load test (§9.6) passes on every engine in the release before the release is published. | Release builder gate R9 |
| SC7 | The doctor report contains no Windows user name, no provider keys, and no other MCP server entries. | Unit test on the report renderer |

---

## 3. Decisions (settled 2026-09-28)

| Q | Decision |
|---|---|
| Q1 Plugin location | Default `<Project>/Plugins/`, one copy per project. `<Engine>/Engine/Plugins/Marketplace/` is available under **Advanced** only. |
| Q2 5.7 binaries | Rule: if the `ENGINE_MINOR_VERSION` guards take a few days or less, ship both engines from one commit. Otherwise installer v1 ships 5.8 only and the download page says so. **Spike result:** main misses compiling on 5.7 by 5 root causes at 8 sites (listed in §10.1). The estimate is about 1.5–2 dev-days, up to 3 if the 5.7 automation run finds runtime differences. That is inside the threshold, so **v1 ships 5.7 and 5.8 from one commit**. Fallback trigger: if the 5.7 `Hayba` automation run (63 tests) finds runtime problems that are not fixable in about a day, v1 ships 5.8 only. In that case the download page says "This release supports Unreal Engine 5.8; 5.7 users can build from source", and `plugins/index.json` and `latest.json` list 5.8 only. |
| Q3 Clients | Auto-configure Claude Code, Claude Desktop, Cursor and VS Code, pre-ticked when detected. Windsurf/Devin and Codex come in the next release. |
| Q4 Signing | The tester beta is the unsigned one-liner. Before the public exe: Azure Trusted Signing if Hayba is eligible, otherwise an OV certificate on a cloud HSM. |
| Q5 Fab | Only after installer v1 ships and the satellites are folded into the Toolkit as optional modules. |
| Q6 Updates | Re-run the installer or the one-liner. The editor shows an update-available notice from `latest.json` plus the version handshake (G5). An opt-in self-updater comes later. |

---

## 4. Architecture

```
                      GitHub Release vX.Y.Z (HTTPS)
      ┌──────────────────────────────────────────────────────────┐
      │ hayba-X.Y.Z-win-x64.zip  (payload)   SHA256SUMS          │
      │ latest.json   install.ps1   HaybaSetup-X.Y.Z.exe (later) │
      │ hayba-X.Y.Z-ue5.7-symbols.zip / ...-ue5.8-symbols.zip    │
      └───────────▲──────────────────────────────┬───────────────┘
                  │ publish (R10)                │ download + verify
   ┌──────────────┴──────────┐        ┌──────────▼──────────────────────────┐
   │ Release builder         │        │ Front doors                         │
   │ (self-hosted build host │        │  B  install.ps1  (irm | iex)        │
   │  with UE 5.7 + 5.8)     │        │  A  HaybaSetup.exe (Inno, per-user) │
   │  F1 plugins per engine  │        │  E  in-editor "Connect AI client"   │
   │  F2 runtime bundle      │        └──────────┬──────────────────────────┘
   │  F5 assets + manifests  │                   │ runs with bundled node.exe
   └─────────────────────────┘        ┌──────────▼──────────────────────────┐
                                      │ Setup core  hayba-setup.mjs         │
                                      │ install | doctor | uninstall |      │
                                      │ update                              │
                                      └──┬───────┬────────┬────────┬────────┘
                    runtime + registry   │       │ plugin │ client │ manifest
               %LOCALAPPDATA%\Programs\Hayba     │ copies │ configs│ %LOCALAPPDATA%\Hayba
                                                 ▼        ▼
                                <Project>\Plugins   Claude Code / Claude Desktop /
                                                    Cursor / VS Code
```

At run time, the editor plugin finds the shared runtime through `HKCU\Software\Hayba\InstallDir` (G1, G2) and starts the chat sidecar from it on port 7821. AI clients start the same server over stdio, using the absolute `node.exe` and `dist\bootstrap.js` paths written into their configs.

---

## 5. On-disk layout

### 5.1 Runtime: `%LOCALAPPDATA%\Programs\Hayba\` (per user, installed once)

```
%LOCALAPPDATA%\Programs\Hayba\
  VERSION                     JSON, §8.1 (written last; it marks a finished swap)
  LICENSE                     Hayba (MIT)
  THIRD_PARTY_NOTICES.txt     production npm packages + Node
  node\node.exe               official Node 24 LTS win-x64, unmodified, OpenJS-signed
  node\LICENSE
  server\package.json         version stamped; no scripts, no devDependencies
  server\hayba.agents.json    read from the package root (agent-registry.ts:29-31)
  server\dist\**              build:server output, without tests, .map or .d.ts
  server\node_modules\**      production closure; @hayba/brain-protocol as a real directory when present
  server\dashboard\dist\**    found by dashboard/server.ts:25
  server\Resources\node_catalog.json, pcgex_registry.db   found by config.ts:29
  setup\hayba-setup.mjs, setup\lib\**, setup\hayba.ico
  plugins\index.json          §8.2
  plugins\<engine>\files.json §8.2
  plugins\<engine>\HaybaMCPToolkit\**, HaybaMCPGAS\**, HaybaMCPMetaSound\**
  unins000.exe, unins000.dat  only when installed by HaybaSetup.exe
```

The approved layout listed `{node, server, setup, VERSION}`. This spec adds `plugins\`, a copy of the per-engine plugin sets (about 26 MB for two engines). It lets `install --project` add Hayba to another project, and lets doctor repair a copy, without downloading again. It also adds the licence files.

Temporary siblings `.staging-*` and `.old-*` exist only while a swap runs. The core deletes leftovers when it starts.

### 5.2 Data: `%LOCALAPPDATA%\Hayba\` (per user; kept on uninstall unless `--remove-data`)

```
%LOCALAPPDATA%\Hayba\
  install-manifest.json       §8.5
  setup.lock                  held while a setup command runs (pid inside)
  memory\hayba-memory.db      HAYBA_MEMORY_DB in client entries; also the G7 default
  pcgex\                      user-scraped registry and catalog (G7)
  scratch\                    per-project stores when no project is known (G3)
  instances\                  user-level editor heartbeats (G11, proposed)
  logs\setup-<UTC>.log        last 20 kept
  backups\<UTC>\<client-id>\<file>   client config originals, before our first edit in that run
```

### 5.3 Registry (HKCU only)

| Key | Values | Writer |
|---|---|---|
| `HKCU\Software\Hayba` | `InstallDir` (REG_SZ, absolute runtime dir), `Version` (REG_SZ) | core, runtime step |
| `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Hayba` | `DisplayName`=Hayba, `DisplayVersion`, `Publisher`=Hayba, `InstallLocation`, `DisplayIcon`=`setup\hayba.ico`, `UninstallString`=`"<rt>\node\node.exe" "<rt>\setup\hayba-setup.mjs" uninstall --front-door ps1`, `NoModify`=1, `NoRepair`=1, `EstimatedSize` | core, only with `--front-door ps1` |
| `...\Uninstall\{<AppId>}_is1` | Inno's own entry | Inno, front door A only. The core deletes the ps1 key when `--front-door inno` runs, so only one entry shows in Apps & features. |

### 5.4 Per project

```
<Project>\Plugins\HaybaMCPToolkit\       real directory (never a link); Installed:true build
<Project>\Plugins\HaybaMCPGAS\           only when ticked, or already present
<Project>\Plugins\HaybaMCPMetaSound\     only when ticked, or already present
<Project>\Saved\HaybaSetup\staging-<ver>\   during a copy only
<Project>\Saved\HaybaSetup\backup\<UTC>\   the previous copy; the last 2 are kept
<Project>\Saved\Logs\HaybaSidecar.log    written by the sidecar (G3)
```

Staging and backups live under `Saved\`, not `Plugins\`. UE scans `Plugins\` for `.uplugin` files, so a backup there would register a duplicate plugin. `Saved\` is on the same volume as `Plugins\`, so the swap is a pair of renames.

With the Advanced engine location, the copy goes to `<Engine>\Engine\Plugins\Marketplace\HaybaMCPToolkit\`, and staging and backups go to `<Engine>\Engine\Saved\HaybaSetup\`. Each selected `.uproject` gets `{ "Name": "HaybaMCPToolkit", "Enabled": true }`, and its original is backed up.

### 5.5 Ports

| Port | Owner | Notes |
|---|---|---|
| 52342–52350 | Editor TCP listener; the first free port wins | HaybaMCPModule.cpp:425-426 |
| 7821 | Chat sidecar started by the plugin | `DASHBOARD_PORT` is set from `SidecarURL` (HaybaMCPModule.cpp:514-515). On main the visual sidecar also defaults to 7821 (`addons/visual-embeddings/.../server.py:97`); the brain-client branch moves it to 7822 |
| 52360 | Dashboard of a server started by an AI client | config.ts:51 default. If the port is in use, the server skips the dashboard and stdio keeps working (dashboard/server.ts:96-104) |
| 3091 | Slivers HTTP | http/server.ts:28 (`HAYBA_MCP_HTTP_PORT`) |

Client entries must **not** set `DASHBOARD_PORT`. Otherwise a client-started server could take 7821 before the editor does.

---

## 6. Setup core

### 6.1 Location and constraints

```
installer/
  setup/
    hayba-setup.mjs          entry: argument parsing, dispatch, exit codes
    lib/*.mjs                modules in §6.3
    lib/vendor/jsonc-parser/ vendored Microsoft jsonc-parser (MIT), pinned; LICENSE kept
    hayba.ico
    test/**                  node:test suites + fixtures
  ps/install.ps1.tmpl        template; the builder fills in the version and hash
  inno/HaybaSetup.iss
  release/build-release.mjs, release/lib/**, release/host-template/**, release/node-version.json
```

- **No npm dependencies at run time.** Only Node built-ins and the vendored `jsonc-parser` (for edits that keep comments and formatting).
- **ESM, `// @ts-check` with JSDoc types.** No build step, so the file that ships is the file that was tested.
- **Tests use `node --test`** so they run on the bundled Node itself. Root script: `"test:installer": "node --test installer/setup/test"`.
- **One I/O seam.** Every module receives a `ctx` object and never imports `node:fs` or `child_process` directly:

```js
/** @typedef {{
 *   fs: FsPort,        // readFile, writeFile, rename, rm, mkdir, lstat, stat, readdir, realpath, copyFile, open/fsync
 *   reg: RegPort,      // query(key) -> {values, subkeys}; set(key,name,type,data); delete(key[,name])
 *   proc: ProcPort,    // list(imageName) -> [{pid, exe, cmdline}]; kill(pid); exec(file,args,opts) -> {code,stdout,stderr}
 *   net: NetPort,      // httpGet(url,{timeoutMs}) -> {status, body}; tcpListening(port) -> pid|null
 *   env: Record<string,string>, now: () => Date, rand: () => string,
 *   ui: UiPort,        // isTTY, prompt, choose, confirm, progress(step,pct,msg), info/warn/error
 *   log: LogPort
 * }} Ctx */
```

The real implementation uses `node:fs`, `reg.exe` (`%SystemRoot%\System32\reg.exe`, absolute path), `tasklist`/`taskkill`, PowerShell `Get-CimInstance Win32_Process`, `netstat -ano`, `fetch`, and `%SystemRoot%\System32\tar.exe` for zip extraction. Tests use in-memory fakes (§13).

### 6.2 CLI

```
node hayba-setup.mjs <command> [flags]
commands: install | doctor | uninstall | update
```

**Global flags**

| Flag | Meaning |
|---|---|
| `--json` | Print one JSON result document (§8.7) on stdout. Human-readable text goes to stderr. |
| `--out <file>` | Also write the JSON result to `<file>` (atomic write). Used by Inno and by the editor. |
| `--progress <file>` | Append progress events as JSON Lines: `{"t":ISO,"step":id,"pct":0-100,"message":text}`. |
| `--yes`, `-y` | Never prompt; use the defaults in §6.4. Implied when stdin is not a TTY. |
| `--log <file>` | Default `%LOCALAPPDATA%\Hayba\logs\setup-<UTC>.log`. |
| `--front-door ps1\|inno\|editor\|manual` | Default `manual`. Selects the uninstall-key behaviour (§5.3) and the wording of messages. |
| `--allow-elevated` | Allow an elevated (admin) process. Refused by default; see §11. |
| `--help`, `--version` | |

**`install`**

| Flag | Default | Meaning |
|---|---|---|
| `--payload <dir>` | the payload root this core was started from (`<core dir>\..`) | Must contain `VERSION` and `plugins\index.json`. |
| `--project <path>` (repeatable) | see §6.4 | A `.uproject` file, or a folder containing exactly one. |
| `--engine <5.7\|5.8>` | all supported | Consider only projects on this engine. |
| `--clients <list>` | `detected` | Comma list of `claude-code,claude-desktop,cursor,vscode`, or `detected`, or `none`. |
| `--only <parts>` | `runtime,projects,clients` | A subset. `--only clients` skips the editor check, so it can run from inside the editor. |
| `--plugin-location project\|engine` | `project` | `engine` is the Advanced option (§5.4). |
| `--satellites <list>` | `none` (satellites already present are upgraded) | `gas,metasound` or `none`. |
| `--plan` | off | Detect and print the plan (§8.7 with `result:"planned"`). Writes nothing except the `--out` file, if one is given: no log file, no lock file. |
| `--no-doctor` | off | Skip the final doctor. |

**`doctor`:** `--project <path>` (repeatable; default: the manifest's projects), `--no-boot` (skip the server boot probe), `--report <file>` (write the pasteable report).

**`uninstall`:** `--project <path>` (repeatable; remove only from these projects and keep runtime and clients), `--clients <list>` (remove only these entries), `--remove-data` (also delete `%LOCALAPPDATA%\Hayba` and the project backups). With neither `--project` nor `--clients`, it is a full uninstall.

**`update`:** `--check` (report only), `--version <x.y.z>` (default: latest). It downloads and verifies the payload (§6.13), then starts the **new** payload's core with `install --payload <new>`, passing on `--yes`, `--json`, `--out` and `--front-door`.

**Exit codes** (the same for every command; install.ps1 and Inno map them to messages)

| Code | Meaning |
|---|---|
| 0 | Success. Warnings are possible. |
| 1 | Internal error (a bug). The message points to the log and the issue tracker. |
| 2 | Usage error: unknown flag, bad value, or no payload found. |
| 3 | Blocked by a running process: Unreal Editor, a Hayba server we could not stop, or another setup run holding `setup.lock`. |
| 4 | Nothing to act on: no supported engine or project for `install`, or no manifest for `uninstall`. |
| 5 | Integrity failure: hash mismatch, BuildId mismatch, unsupported engine for an explicitly requested project, or a malformed payload. |
| 6 | A write failed and was rolled back: permissions, read-only files, a locked file, or a full disk. |
| 7 | Partial success. Some projects or clients failed and the rest succeeded (details in JSON). Also used when the final doctor has a failing check. |
| 8 | `doctor` only: at least one check failed. |
| 9 | Refused environment: elevated process, unsupported OS or architecture, or PowerShell Constrained Language Mode (install.ps1). |
| 10 | `update --check` only: an update is available. |
| 11 | Network error: download or `latest.json` fetch failed. |
| 130 | Cancelled by the user (Ctrl+C or a declined prompt). |

### 6.3 Module split

| Module | Input | Output / effect |
|---|---|---|
| `cli.mjs` | argv, ctx | Parsed command and flags. Dispatches, renders text or JSON, maps errors to exit codes. |
| `lock.mjs` | data dir | Takes `setup.lock` (exclusive create; a lock whose pid is dead is stolen). Exit 3 if the holder is alive. |
| `preflight.mjs` | ctx, runtime dir, target projects, `--only` | `{ elevated, arch, editors:[{pid,exe,uproject?}], ourNodes:[{pid,exe,cmdline}], port7821:{state:'free'\|'hayba'\|'foreign', version?, pid?, image?} }`. `stopOurNodes()` kills only processes whose image path is under `<runtime>\node\`. |
| `payload.mjs` | payload dir | A validated `Payload` `{version, commit, node, engines:[{engine,buildId,plugins}], dir}` read from `VERSION`, `plugins\index.json` and `files.json`. `verifyTree(dir, files.json)` checks per-file SHA256. |
| `runtime.mjs` | ctx, Payload, runtime dir | Stages and swaps `node\ server\ setup\ plugins\` and the licence files, then writes `VERSION` last. Returns `{action:'installed'\|'upgraded'\|'unchanged', previousVersion, paths[]}`. Writes `HKCU\Software\Hayba`. |
| `engines.mjs` | ctx, Payload | `Engine[] = {id, root, version:{major,minor,patch,changelist}, buildId, sources[], sourceBuild, supported, reason}`. §6.7. |
| `projects.mjs` | ctx, Engine[], manifest | `Project[] = {uproject, name, engineAssociation, engine?, hasCode, lastOpened?, via[], hayba:{present, kind:'copy'\|'link'\|'engine'\|null, version?, managed:boolean}, supported, reason, default}`. §6.8. |
| `plugin-copy.mjs` | ctx, Project, Payload, options | Stages, verifies, backs up and swaps. Returns `{action:'install'\|'upgrade'\|'unchanged'\|'skip', reason?, pluginDirs[], backup?, treeHash}`. §6.9. |
| `server-entry.mjs` | runtime dir, data dir | The canonical `ServerEntry {command, args, env}` (§8.6). |
| `jsonfile.mjs` | path, key path, value or `undefined` | Reads (BOM, JSONC, symlink target), edits with `jsonc-parser`, backs up, writes atomically (§6.10.1). |
| `clients/index.mjs` | ctx | The registry of writers below. |
| `clients/claude-code.mjs` | ctx, ServerEntry | CLI writer (§6.10.2) |
| `clients/claude-desktop.mjs` | ctx, ServerEntry | file writer (§6.10.3) |
| `clients/cursor.mjs` | ctx, ServerEntry | file writer (§6.10.4) |
| `clients/vscode.mjs` | ctx, ServerEntry | file writer (§6.10.5) |
| `doctor.mjs` | ctx, manifest, options | `Report {ok, checks:[{id, status:'pass'\|'warn'\|'fail', detail, fix?}]}` and `renderText(report)` with the user folder redacted. §6.11. |
| `manifest.mjs` | data dir | `load()`, `save()` (atomic), `recordIntent(entry)` before each write, `markDone(entry)`. Schema in §8.5. |
| `release.mjs` | ctx, version? | Fetches `latest.json` and `SHA256SUMS` over HTTPS, downloads, verifies, extracts. §6.13. |

Each client writer implements the same interface:

```js
/** @type {{
 *   id: 'claude-code'|'claude-desktop'|'cursor'|'vscode', label: string,
 *   detect(ctx): { present: boolean, target: {kind:'file', path, key} | {kind:'cli', exe, scope:'user'} | {kind:'manual'},
 *                  blocked?: {reason: string, detail: string}, notes: string[] },
 *   read(ctx, target): { state: 'absent'|'same'|'different'|'unparseable', error?: string },
 *   apply(ctx, target, entry): { action: 'add'|'update'|'unchanged', backup?: string },
 *   remove(ctx, target, opts:{onlyIfOurs:boolean, runtimeDir:string}): { action: 'removed'|'absent'|'kept', backup?: string },
 *   afterMessage(action): string|null
 * }} ClientWriter */
```

### 6.4 `install` flow

1. Parse the flags and take the lock (not for `--plan`). Refuse an elevated process (exit 9) unless `--allow-elevated`. Refuse anything other than x64 Windows 10 1809+ or 11 (exit 9).
2. Load the payload (`payload.mjs`) and the manifest, if one exists.
3. Detect engines, projects and clients.
4. **Build the plan.**
   - **Runtime:** `install`, `upgrade` or `unchanged` (the `VERSION` file equals the payload's and the tree hashes match).
   - **Projects, default selection:**
     1. every project in the manifest (upgrade);
     2. plus, in interactive mode or when the manifest is empty, the supported project with the newest `LastOpenTime`;
     3. plus any `--project` given.

     A project holding a Hayba copy that is **not** in the manifest is replaced only when the user explicitly selects it.
   - **Clients:** every detected client that is not blocked (for `--clients detected`).
5. `--plan`: print and exit 0.
6. **Interactive** (TTY and no `--yes`): show the plan as a numbered checklist. Projects show name, engine and "last opened" time; unsupported projects are greyed out with the reason; clients show detected or blocked. Let the user toggle items, add a project by path, or cancel. Then confirm.
7. **Preflight** (§6.5).
8. Runtime step (§6.6). A failure here stops the run (exit 5/6).
9. Plugin copy for each selected project (§6.9). Projects are independent; a failure marks that project failed and the run continues.
10. Client writers for each selected client (§6.10). Clients are independent in the same way.
11. The manifest is saved after every step, recording intent before each write (§6.12).
12. Doctor in quick mode (§6.11), unless `--no-doctor`.
13. **Summary:** results per item, the follow-up messages each client needs (for example "Quit Claude Desktop from the tray"), the log path, and the exit code (0, or 7 if anything failed).

### 6.5 Preflight

- **Unreal Editor.** List `UnrealEditor.exe` and `UnrealEditor-Cmd.exe` with their command lines through `Get-CimInstance Win32_Process` (fallback: `tasklist`, which gives PIDs only). Any running editor blocks the `runtime` and `projects` parts. An editor holds its project's plugin DLL, and its sidecar runs on our `node.exe`.
  - Interactive: "Unreal Editor is running (MyGame). Save your work and close it, then press Enter. Press Ctrl+C to cancel." Re-check on Enter.
  - `--yes`: exit 3.
  - The core never terminates an editor.
- **Our Node processes.** List `node.exe` processes whose `ExecutablePath` is under `<runtime>\node\` (a case-insensitive prefix match on the normalised full path).
  - Tell the user which ones will stop: "Stopping 2 Hayba server processes started by your AI apps. They start again the next time those apps use Hayba."
  - Kill them with `taskkill /PID <pid> /T /F`. Anything else is never touched.
  - If one cannot be stopped: exit 3.
  - `--only clients` skips this step.
- **Port 7821.** `netstat -ano` → the PID and image of the listener, and `GET http://127.0.0.1:7821/api/health` with a 1 s timeout.
  - A Hayba answer is fine, and is reported with its version (after G5).
  - A foreign listener produces a **warning**, not a failure: "Port 7821 is used by `<image>` (PID n). Hayba will install, but the in-editor chat can't start until that port is free or you change Sidecar URL in Hayba settings."
- **Disk.** At least 400 MB free on the runtime volume, and 60 MB on each target project's volume. Otherwise exit 6 before any write.

### 6.6 Runtime step

1. Delete leftover `.staging-*` and `.old-*` siblings from an interrupted run.
2. If the installed `VERSION` equals the payload's and the tree hashes match, the step is `unchanged`. Stop here.
3. Copy the payload's `node\ server\ setup\ plugins\` and licence files into `<rt>\.staging-<ver>-<rand>\`. Verify against `files.json` and the server manifest hash.
4. **Swap.** For each of `node server setup plugins`:
   - rename `<rt>\<name>` to `<rt>\.old-<UTC>\<name>`;
   - rename the staged `<name>` to `<rt>\<name>`.

   Then do the same for the licence files. Write `VERSION` last. If any rename fails, reverse the renames already made and exit 6.
5. Write `HKCU\Software\Hayba` `InstallDir` and `Version`. With `--front-door ps1`, write the uninstall key. With `--front-door inno`, delete the ps1 uninstall key if we own it.
6. Delete `.old-*`. If a file is locked, leave it; the next run cleans up.

The core never replaces the runtime while it runs from `<rt>\node\node.exe`. `install` always runs from a payload in `%TEMP%` or Inno's `{tmp}`. `update` hands off to the downloaded payload's core. `uninstall` copies `node.exe` and `setup\` into `%TEMP%\hayba-uninstall-<rand>\` and starts itself again from there when it detects that it is running inside `<rt>`.

### 6.7 Engine detection (mirrors UE's own)

Sources, merged by normalised root:

1. `%ProgramData%\Epic\UnrealEngineLauncher\LauncherInstalled.dat`. Keep `InstallationList[]` entries whose `AppName` starts with `UE_` (FabPlugin_ and other Launcher items share `InstallLocation`). The id is `AppName` without `UE_`, for example `5.8`.
2. `HKCU\SOFTWARE\Epic Games\Unreal Engine\Builds`. The value name is the id (a GUID for custom builds) and the data is the root.
3. `HKLM\SOFTWARE\EpicGames\Unreal Engine\<ver>` `InstalledDirectory`. This is informational only: it can be stale, and it has no 5.8 entry on the build host *(checked on build host: 4.0 and 5.6 entries point at missing roots)*.

For each root:

- **Valid root:** `Engine\Binaries` and `Engine\Build` both exist.
- **Version:** read from `Engine\Build\Build.version` (`MajorVersion`, `MinorVersion`, `PatchVersion`, `Changelist`).
- **BuildId:** read from `Engine\Binaries\Win64\UnrealEditor.modules` (`BuildId`). On Launcher engines this equals `CompatibleChangelist` in `Build.version` *(checked on build host: 5.7.4 → 47537391, 5.8.2 → 55116800)*. Cross-check the two and warn if they differ.
- **Source build:** `Engine\Build\SourceDistribution.txt` exists.
- **Supported** when all of these hold:
  - the root is valid;
  - it is not a source build;
  - `major.minor` is listed in `plugins\index.json`;
  - its `BuildId` equals the listed one.
- **`reason` when not supported:** `invalid-root`, `source-build`, `older-than-5.7`, `newer-than-release` (for example 5.9), or `buildid-mismatch`.

The starting point is `detect-probe.mjs` from the groundwork, which is read-only and was run on the build host.

### 6.8 Project detection

**Candidates:**

1. **Recent projects.** Each engine's `EditorSettings.ini`, lines `RecentlyOpenedProjectFiles=(ProjectName="<path>",LastOpenTime=YYYY.MM.DD-hh.mm.ss)` *(format checked on build host)*. The ini lives at:
   - Launcher engines: `%LOCALAPPDATA%\UnrealEngine\<id>\Saved\Config\WindowsEditor\EditorSettings.ini`;
   - source-built or custom engines: `<root>\Engine\Saved\Config\WindowsEditor\EditorSettings.ini`.
2. **Created-project folders.** `CreatedProjectPaths=<dir>` lines from the same files. Scan one level deep for `*.uproject`, as `FDesktopPlatformBase::EnumerateProjectsKnownByEngine` does.
3. **`<Documents>\Unreal Projects`,** one level deep. Documents is the **known folder**, not `%USERPROFILE%\Documents`: read `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders` `Personal` (REG_EXPAND_SZ; expand the variables). This follows a OneDrive redirect. Fallback: `[Environment]::GetFolderPath('MyDocuments')` through PowerShell.
4. **Picker.** Interactive mode prompts for a path. Inno shows a browse dialog. `--project` provides paths directly.

**Engine mapping** uses `EngineAssociation` in the `.uproject`:

- `"5.8"`: the Launcher id.
- `"{GUID}"`: the value name under HKCU Builds.
- `""`: the engine whose root contains the project, otherwise unresolved. An unresolved project is skipped with a message, and `--engine` resolves it.

**Other fields:**

- `hasCode` = `Modules[]` is not empty.
- `hayba.kind`:
  - `link` if `lstat(<Project>\Plugins\HaybaMCPToolkit).isSymbolicLink()`. Node reports junctions as symbolic links *(checked on build host, Node 24.14)*.
  - `copy` if it is a real directory.
  - `engine` if the Toolkit is present only in the engine's Marketplace folder.
- `managed` = the project is in the manifest.

### 6.9 Plugin copy

For each selected project, with engine E:

1. **Refuse** (result `skip`, and the run continues) when:
   - `Plugins\HaybaMCPToolkit`, or `Plugins` itself, is a link, or its real path lies inside a Hayba source checkout (a folder containing `mcp-tools\hayba-mcp`). Message: "Left `<path>` alone: it is a link to a developer checkout."
   - any existing file in the Hayba plugin directories is read-only (`(mode & 0o200) === 0`). Message: "`<Project>`: Hayba's plugin files are read-only, probably because they are checked in to source control. Check out `Plugins/HaybaMCPToolkit` and run the installer again."
2. **Choose the set.**
   - The Toolkit always.
   - Satellites that are ticked, or already present in the project (the locked set: all of them come from the same release).
   - Stale `HaybaMCPNiagara` and `HaybaMCPSequencer` directories, which ADR-0008 removed, are moved into the backup and reported.
3. **Stage.** Copy `<rt>\plugins\E\<P>\` into `<Project>\Saved\HaybaSetup\staging-<ver>\<P>\`. Verify every file against `files.json`.
4. **Check the BuildId.** The staged `Binaries\Win64\UnrealEditor.modules` `BuildId` must equal the engine's. If not: exit 5 for an explicitly requested project, otherwise `skip`.
5. **Unchanged?** If the existing copy's tree hash equals the staged one, the result is `unchanged`. Delete the staging.
6. **Swap.**
   - rename `Plugins\<P>` to `Saved\HaybaSetup\backup\<UTC>\<P>`;
   - rename `staging\<P>` to `Plugins\<P>`.

   Roll back on any failure. If `Saved` is on another volume (a junction), fall back to copy and delete, and note in the log that this path is not atomic.
7. Prune older backups, keeping 2. Record in the manifest: `pluginDirs`, `backup`, `treeHash`, `version`, `engine`, `buildId`.
8. **Advanced engine location:** the same steps against `<Engine>\Engine\Plugins\Marketplace\`, followed by the `.uproject` enable edit through `jsonfile.mjs` (backed up, `uprojectEdited:true`). If `Marketplace\` is not writable: "Can't write to `<path>`. Use the default project install instead." Launcher engines grant `BUILTIN\Users:(OI)(CI)(F)` there *(checked on build host, UE 5.8)*.

After the swap, if the project is under version control, the summary notes that `Plugins/HaybaMCPToolkit` changed. The core never touches VCS.

### 6.10 Client writers

All four receive the same `ServerEntry` (exact JSON in §8.6):

- `command` = `<rt>\node\node.exe`
- `args` = `[<rt>\server\dist\bootstrap.js]`
- `env`:
  - `HAYBA_MEMORY_DB` = `%LOCALAPPDATA%\Hayba\memory\hayba-memory.db`;
  - `HAYBA_CODE_MODE` = `on` (config.ts:74 treats anything but `off` as on; the value is explicit so the intent is visible to anyone reading the config).

Paths are absolute and expanded; JSON config files do not expand `%VAR%`. The server name is always `hayba`.

#### 6.10.1 File-writer algorithm (Claude Desktop, Cursor, VS Code)

1. **Resolve the target path.** If it is a symlink, resolve it with `realpath` and write to the target, so a dotfiles link is not replaced by a regular file. If the file is missing, use `{}` and create the parent folder.
2. **Read the bytes.** Remember whether a UTF-8 BOM was present, the line endings (CRLF or LF) and the indent (tabs, 2 or 4 spaces).
3. **Parse with `jsonc-parser`** (comments and trailing commas allowed).
   - On a parse error, or a root that is not an object, **refuse**: "`<file>` is not valid JSON (line L, column C). Hayba left it untouched. Fix or move the file and run the installer again." That client's result is `failed`; the other clients continue.
4. **Compare.** If `<key>.hayba` deep-equals the desired entry, the result is `unchanged`: no backup and no write.
5. **Back up** the original bytes to `%LOCALAPPDATA%\Hayba\backups\<UTC>\<client-id>\<basename>`, if the file existed.
6. **Edit.** `modify(text, [key, 'hayba'], entry, {formattingOptions})` → `applyEdits`, which preserves comments, key order, unknown keys and the formatting style. Re-parse the result and assert that nothing outside `<key>.hayba` changed. If anything did, abort with exit 1 (a bug).
7. **Write atomically.**
   - write `<path>.hayba-tmp-<rand>` in the same folder, with the BOM if the original had one, and fsync it;
   - rename it over the target (on Windows, `fs.renameSync` replaces an existing file);
   - on EPERM or EBUSY (the app or antivirus holds the file), retry 5 times with backoff from 100 to 1600 ms, then report `failed` with "Windows is holding `<file>` open. Close `<app>` and run the installer again."
8. **Remove** uses the same path with `value = undefined`. If `<key>` becomes empty, it is left as `{}`.

The writers read and touch only `<key>.hayba`. The values of other entries are never logged, printed or copied anywhere except the byte-for-byte backup, because they may hold other tools' API keys (§11).

#### 6.10.2 Claude Code (CLI)

- **Blocked** when `C:\Program Files\ClaudeCode\managed-mcp.json` exists: the organisation manages MCP servers. The result is `manual`, with the message "Your organisation manages Claude Code's MCP servers. Ask your administrator to add this entry:" followed by the JSON. If `managed-settings.json` exists in the same folder with `allowedMcpServers` or `deniedMcpServers`, add a warning that the entry may be filtered.
- **Executable:**
  1. the first `claude.exe` on `PATH` (`.exe` only);
  2. otherwise `%USERPROFILE%\.local\bin\claude.exe` (the native installer's location; *checked on build host*).

  If only a `.cmd` or `.ps1` shim exists (an npm install), the result is `manual` and the core prints the exact command to paste. The core never runs a shell to call a shim, because quoting JSON through `cmd.exe` is not reliable.
- **Read.** Parse `%USERPROFILE%\.claude.json` (read-only, BOM-safe). Compare `mcpServers.hayba` (user scope) with the desired entry.
  - Also list any project-scope `projects[<dir>].mcpServers.hayba` entries and report them as warnings: "A project-level 'hayba' entry in `<dir>` overrides this one." The core does not touch them.
- **Apply.**
  - If absent: `claude.exe mcp add-json hayba <json> --scope user`, run through `execFile` with an argv array (no shell) and a 30 s timeout.
  - If different: `claude.exe mcp remove hayba --scope user` first, then add.

  Re-read `.claude.json` to confirm. *(Checked on build host: Claude Code 2.1.283 has `mcp add-json <name> <json> -s user` and `mcp remove <name> -s user`.)*
- **Remove:** `claude.exe mcp remove hayba --scope user`.
- **After:** "Restart any open Claude Code sessions to load Hayba."

#### 6.10.3 Claude Desktop (file, key `mcpServers`)

- **Detect:** `%APPDATA%\Claude\` exists, or a `%LOCALAPPDATA%\Packages\Claude_*` folder exists (MSIX).
- **Target:**
  - if any `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json` **exists**, use the one with the newest modification time (the MSIX shadow copy wins, because the packaged app reads it first);
  - otherwise `%APPDATA%\Claude\claude_desktop_config.json`.

  *(Checked on build host: an MSIX package folder exists, with no shadow config; the `%APPDATA%` file exists.)*
- **After:** "Quit Claude Desktop from the system tray (closing the window is not enough), then start it again."

#### 6.10.4 Cursor (file, key `mcpServers`)

- **Detect:** `%USERPROFILE%\.cursor\` or `%LOCALAPPDATA%\Programs\cursor\` exists.
- **Target:** `%USERPROFILE%\.cursor\mcp.json`.
- `cursor --add-mcp` exists *(checked on build host)* but is not used. It has no matching remove, and the file writer gives idempotency, uninstall and tests in one code path.
- **After:** "Restart Cursor, or turn Hayba on under Settings → MCP."

#### 6.10.5 VS Code (file, key `servers`)

- **Detect:** `%APPDATA%\Code\User\` or `%LOCALAPPDATA%\Programs\Microsoft VS Code\` exists.
- **Target:** `%APPDATA%\Code\User\mcp.json`, under **`servers`** (not `mcpServers`), with `"type": "stdio"`. The file is often JSONC, which the vendored parser handles.
- Only the default profile is written. Non-default profiles are reported as a note.
- `code --add-mcp` is not used, for the same reason as Cursor.
- **After:** "Reload VS Code windows to load Hayba." (Whether VS Code picks the change up live: OV-12.)

### 6.11 Doctor

| Id | Check | Pass | Warn / Fail and fix text |
|---|---|---|---|
| `runtime.present` | `node.exe`, `server\dist\bootstrap.js`, `VERSION` exist; `VERSION.version` equals the manifest | all true | FAIL: "Hayba's runtime is missing or incomplete. Run the installer again." |
| `runtime.node` | `node.exe -p process.versions.node` | ≥ 22.13.0 (the bundled one is 24.x) | FAIL, with the same fix |
| `runtime.boot` | Spawn `node.exe bootstrap.js` with `cwd=<data>\scratch`, a temporary `HAYBA_MEMORY_DB`, and free ephemeral `DASHBOARD_PORT` and `HAYBA_MCP_HTTP_PORT`. Send MCP `initialize` over stdio; expect a result within 20 s. Then `GET /api/health` on the dashboard port. Kill the process tree. | initialize OK, `status:"ok"`, and the version equals `VERSION` (after G5) | FAIL: "The Hayba server did not start" plus the last 20 stderr lines, redacted |
| `data.writable` | Create and delete a temporary file under `%LOCALAPPDATA%\Hayba` | ok | FAIL: "Can't write to `<dir>`" |
| `project.<n>.plugin` | The plugin directory exists; its kind; `VersionName` against the runtime version; plugin `BuildId` against the engine `BuildId` | real copy, same version, same BuildId | WARN for a link ("developer link, not managed") or a version skew ("re-run the installer for this project"). FAIL for a BuildId mismatch ("this copy was built for a different engine build; re-run the installer") |
| `project.<n>.engine` | The engine is still present and supported | yes | FAIL, with the §6.7 reason text |
| `port.7821` | Same as preflight | free, or Hayba with the same version | WARN for a foreign process or another version |
| `client.<id>` | The entry exists, parses, and points at existing files | yes | WARN if absent although the manifest has it; WARN if blocked or manual |

**Report** (`--report` or text mode), made to paste into an issue:

- The header gives the Hayba version, the Windows build and architecture, and the Node version.
- One line per check.
- `%USERPROFILE%` replaces the user's folder everywhere in the report.
- It never prints provider keys, environment values other than the two Hayba keys, or any client entry other than `hayba` (SC7).

Quick mode (end of install) runs every check. `--no-boot` skips `runtime.boot`.

### 6.12 Manifest and uninstall

The manifest (§8.5) records every path, registry key, config entry and backup the core wrote. The rules:

- An entry is recorded **before** its write (`state:"pending"`) and marked `done` after it, so uninstall can clean up after a crash.
- The manifest is written atomically (temporary file, then rename).

**`uninstall` steps:**

1. Take the lock. Load the manifest; exit 4 if there is none. If running inside `<rt>`, start again from `%TEMP%` (§6.6).
2. Run preflight: editors block project removal; our Node processes are stopped.
3. **Clients.** For each client in the manifest, `remove()`. A `hayba` entry that is not in the manifest is removed only when its `command` points inside `<rt>`. A developer's own `hayba` entry pointing at a repo build is kept and reported.
4. **Projects.** For each manifest plugin directory that is still a real directory (not a link) at the recorded path:
   - rename it to `%TEMP%\hayba-rm-<rand>\` and delete it recursively;
   - revert `.uproject` edits we made (`uprojectEdited`).

   A directory that became a link, or whose `.uplugin` no longer says `CreatedBy: "Hayba"`, is skipped and reported.
5. **Runtime.** Delete the manifest-listed children of `<rt>`, then `<rt>` itself if it is empty. Inno's files belong to Inno.
6. **Registry.** Delete `HKCU\Software\Hayba`, and the ps1 uninstall key if we own it.
7. **Data.**
   - With `--remove-data`: delete `%LOCALAPPDATA%\Hayba` and each project's `Saved\HaybaSetup`.
   - Otherwise: keep `memory\`, `logs\` and `backups\`, and delete `install-manifest.json` and `setup.lock`.

**Deletion guard.** Every recursive delete goes through one `safeRemove(path, expectation)`. It asserts that the path:

- is absolute and normalised;
- is not a link, and is not reached through a link;
- is under an allowed root (`<rt>`, `%LOCALAPPDATA%\Hayba`, a manifest project's `Plugins\` or `Saved\HaybaSetup\`, or the engine's `Plugins\Marketplace\` for engine installs);
- has the expected basename (`HaybaMCPToolkit`, `node`, and so on).

Any mismatch is a bug (exit 1). Nothing is deleted in that case.

**Partial uninstall.** `--project` removes only those projects' copies. `--clients` removes only those entries. The runtime and data are kept in both cases.

### 6.13 Update

1. `GET https://github.com/zajalist/hayba/releases/latest/download/latest.json`, or `.../download/v<ver>/latest.json` with `--version`. HTTPS only; redirects are followed only to `github.com` and `objects.githubusercontent.com`. Timeout 15 s; failure is exit 11.
2. Compare versions (semver). `--check` prints current and latest, then exits 0 (up to date) or 10 (update available). `latest.json` must list the user's engines. If an installed project's engine is missing from it, say so and continue only for the other projects.
3. Download the payload to `%TEMP%\hayba-update-<rand>\`. Check its SHA256 against **both** `latest.json` and the release's `SHA256SUMS`; any disagreement is exit 5, and the files are deleted.
4. Extract with `%SystemRoot%\System32\tar.exe -xf` (bsdtar; it refuses `..` paths). Afterwards, assert that every extracted path is inside the destination folder.
5. Start `<new>\node\node.exe <new>\setup\hayba-setup.mjs install --payload <new> ...` and return its exit code.

`update` runs only when the user asks, and it never runs in the background. That keeps it inside Q6. The self-updater remains a later, opt-in feature.

---

## 7. Front doors and in-editor surface

### 7.1 `install.ps1` contract (front door B)

**Where it lives:**
- `https://hayba.vercel.app/install.ps1`, the static file `website/install.ps1`, deployed with the website's clean-worktree recipe. `vercel.json` has no build step and git auto-deploy is off.
- A copy is attached to each release.

The builder generates it from `installer/ps/install.ps1.tmpl` with `{{VERSION}}`, `{{PAYLOAD_NAME}}`, `{{PAYLOAD_SHA256}}` and `{{REPO}}` filled in. The hash is embedded, so the website (Vercel) and the release (GitHub) are two independent origins: tampering needs both.

**Usage**
```powershell
irm https://hayba.vercel.app/install.ps1 | iex
# with options:
& ([scriptblock]::Create((irm https://hayba.vercel.app/install.ps1))) -Project 'D:\Games\MyGame\MyGame.uproject' -Clients claude-code,cursor
```

**Parameters:**
- `-Version <x.y.z>`: instead of the embedded version, fetch that release's `SHA256SUMS` and use its payload line.
- `-Project <string[]>`, `-Engine <string>`, `-Clients <string>`, `-NoClients`, `-Yes`.
- `-Doctor` and `-Uninstall`: run the installed core's `doctor` or `uninstall`. If there is no runtime: "Hayba isn't installed for this user."
- `-PayloadPath <zip>` together with `-Sha256 <hex>`: for testing only.
- `-KeepDownload`.

**Behaviour, in order:**

1. The whole script body runs inside `& { ... }`, so no variables leak into the user's session. `$ErrorActionPreference='Stop'` and `$ProgressPreference='SilentlyContinue'` are set in that scope (the progress bar makes downloads very slow in Windows PowerShell 5.1).
2. It **never calls `exit`**: under `iex`, `exit` closes the user's PowerShell window. It sets `$global:LASTEXITCODE` and returns.
3. It refuses (code 9, with a message):
   - `$ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage'`: "PowerShell is in Constrained Language mode (set by your organisation). Download the installer from https://hayba.vercel.app/download instead."
   - `$env:PROCESSOR_ARCHITECTURE -ne 'AMD64'`.
   - An elevated session: "Run this from a normal PowerShell window, not as administrator. Hayba installs for your user only and never needs admin rights."
4. It enables TLS 1.2: `[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072`.
5. It creates `%TEMP%\hayba-install-<random>\` and downloads `https://github.com/{{REPO}}/releases/download/v{{VERSION}}/{{PAYLOAD_NAME}}` with `Invoke-WebRequest -UseBasicParsing`. Failure is code 11.
6. It checks `(Get-FileHash -Algorithm SHA256).Hash` against the embedded hash, ignoring case. On a mismatch it deletes the folder and returns code 5: "The download does not match the published checksum. Nothing was installed. Try again later, or report it."
7. It extracts with `& "$env:SystemRoot\System32\tar.exe" -xf` (fallback: `Expand-Archive`).
8. It checks `Get-AuthenticodeSignature node\node.exe`: `Status -eq 'Valid'` and the signer subject starts with `CN=OpenJS Foundation` *(checked on build host for 24.14.0; OV-9 for the pinned build)*. Otherwise code 5.
9. It runs `& $node $core install --payload $root --front-door ps1 [mapped flags]` in the same console, so the core can prompt, and passes `$LASTEXITCODE` through.
10. It deletes the temporary folder unless `-KeepDownload` was given. It prints the core's summary, which already includes the doctor result and the next steps.

The script contains about 120 lines of logic. It does not change the execution policy, write to the registry, or install anything itself.

### 7.2 `HaybaSetup.exe` contract (front door A, Inno Setup 6)

**Script settings:**
- `PrivilegesRequired=lowest`, with no override option;
- `ArchitecturesAllowed=x64compatible`;
- `DefaultDirName={localappdata}\Programs\Hayba`, `UsePreviousAppDir=no`;
- `DisableWelcomePage=yes`, `DisableDirPage=yes`, `DisableProgramGroupPage=yes`, `DisableReadyPage=yes`;
- `Compression=lzma2/ultra64`, `SolidCompression=yes`;
- a fixed `AppId` GUID;
- `SignTool=` and `SignedUninstaller=yes` with an RFC 3161 timestamp (`/tr <tsa> /td sha256 /fd sha256`);
- `CloseApplications=no`, because the core handles running processes.

**Payload.** Embedded as `[Files]` with `Flags: dontcopy`. The installer extracts it to `{tmp}\payload\`; it never goes straight into `{app}`. The core installs the runtime so that the swap and the manifest are the same as on the one-liner path.

**The one page (a custom wizard page, shown first):**
1. While the page shows "Looking for Unreal Engine projects…", the installer runs `{tmp}\payload\node\node.exe {tmp}\payload\setup\hayba-setup.mjs install --plan --json --out {tmp}\plan.json --payload {tmp}\payload --front-door inno`, with the window hidden and waiting for it to finish.
2. It shows two checklists built from `plan.json`: **Projects** (name, "UE 5.8", last opened; `default:true` items pre-ticked; unsupported items disabled, with the reason as a hint) and **AI apps** (detected items pre-ticked; blocked or manual items shown with a note).
3. A **Customize** link reveals: "Add a project…" (a file browse dialog for `.uproject` files), "Install into the engine instead (Advanced)", and "Also install GAS / MetaSound command sets".
4. The Next button reads **Install**.

**Install.** In `CurStepChanged(ssInstall)` the installer runs `... install --yes --json --out {tmp}\result.json --progress {tmp}\progress.jsonl --payload {tmp}\payload --front-door inno` with explicit `--project`, `--clients`, `--plugin-location` and `--satellites` values. A timer reads `progress.jsonl` to drive the progress bar.

**Finish page.** It renders `result.json`: per-item results, each client's follow-up text, the doctor summary, and a "Copy diagnostic report" button, which runs `doctor --report {tmp}\report.txt` and copies the text. An exit code other than 0 or 7 shows the mapped message from §12, and still offers the report.

**Uninstall (Apps & features → Hayba):**
- `InitializeUninstall` asks: "Also remove my Hayba data (memory, logs, backups)?"
- `[UninstallRun]` runs `"{app}\node\node.exe" "{app}\setup\hayba-setup.mjs" uninstall --yes --front-door inno [--remove-data]`. The core moves itself to `%TEMP%` (§6.6).
- Inno then removes `unins000.*` and `{app}` if it is empty.

**Upgrade.** Running a newer `HaybaSetup.exe` is the normal path. The core's upgrade logic applies unchanged.

### 7.3 In-editor surface (plugin)

The code goes in new files under `Private/Installer/`:

- `HaybaRuntimeLocator`: the shared G1/G2 lookup.
- `HaybaClientConnect`.
- `HaybaUpdateNotice`.

These new files change the class layout, so they need a full rebuild. Confirm with `test_list` that the new `.cpp` files are in the binary.

**"Connect AI client"**

- **Entry points:** a button in the Hayba panel's Settings view, and the console command `Hayba.ConnectClient [claude-code|claude-desktop|cursor|vscode ...]`. With no arguments, it uses the detected clients.
- **Flow:**
  1. Resolve the runtime (G1, G2).
  2. Run `<node> <rt>\setup\hayba-setup.mjs install --only clients --plan --json --out <Project>\Saved\HaybaMCP\connect-plan.json --front-door editor` through `FMonitoredProcess` (asynchronous; the game thread never waits).
  3. Show a small dialog listing the clients with their detection state. The user ticks clients and presses Connect.
  4. Run the same command with `--yes --clients <ticked>` and `--out connect-result.json`.
  5. Show a notification for each client:
     - "Connected Claude Desktop — quit it from the tray and restart it";
     - "Already connected";
     - "Needs a manual step", with a **Copy entry** button that puts the exact JSON on the clipboard;
     - "Failed: `<message>`".
- **Without an installed runtime** (the dev layout): "The Hayba runtime isn't installed for this user. Run the installer, or copy this entry into your AI app's config." **Copy entry** then builds the entry from the resolved dev `node.exe` and `bootstrap.js`.
- It never closes the editor and never touches the plugin or the runtime (`--only clients`).

**Update notice**

- **When:** 30 s after startup, once per editor session, if `bCheckForUpdates` is true. That is a per-user setting in `GEditorSettingsIni`, true by default, and it can be turned off in Settings.
- **Request:** FHttpModule `GET https://github.com/zajalist/hayba/releases/latest/download/latest.json` with a 5 s timeout. The request carries no identifiers beyond a normal HTTPS request.
- **Parse:** read `version`, `engines` and `notesUrl`. `notesUrl` is accepted only when it starts with `https://github.com/zajalist/hayba/`.
- **Compare:** against the plugin's `VersionName` (`IPluginManager::FindPlugin("HaybaMCPToolkit")->GetDescriptor().VersionName`).
- **When newer** and not skipped, show a non-modal notification: "Hayba 0.5.0 is available (you have 0.4.0). Re-run the installer to update." Buttons:
  - **How to update**, which opens `https://hayba.vercel.app/download`;
  - **Release notes**;
  - **Skip this version**, which stores `SkippedUpdateVersion`.
- If the user's engine is not in `engines`: "Hayba 0.5.0 is out, but it has no build for UE 5.x yet."
- The notice never downloads or runs anything.
- `Hayba.CheckForUpdates` forces a check.

**Version handshake.** This is G5 (§10), shown in the same notification style.

**Recommendation.** A release without the update notice can never announce the release after it. The notice is small, so land it with the gap fixes if possible (maintainer's call). Otherwise testers on the first beta learn about updates only through the tester channel.

---

## 8. Schemas

### 8.1 `VERSION` (runtime root and payload root)

```json
{
  "schema": 1,
  "product": "hayba",
  "version": "0.4.0",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "builtAt": "2026-10-20T12:00:00Z",
  "node": "24.14.0",
  "engines": { "5.7": "47537391", "5.8": "55116800" },
  "serverTreeSha256": "…64 hex…"
}
```

The plugin reads `node` from this file (G1), so it can trust the bundled Node without spawning it. The version numbers shown are examples. The first installer release must be above both the existing `v0.1.0` tag and the `.uplugin`'s current `0.3.0`; `0.4.0` is proposed.

### 8.2 `plugins/index.json` and `plugins/<engine>/files.json`

```json
{
  "schema": 1,
  "version": "0.4.0",
  "engines": [
    { "engine": "5.7", "buildId": "47537391", "plugins": ["HaybaMCPToolkit", "HaybaMCPGAS", "HaybaMCPMetaSound"] },
    { "engine": "5.8", "buildId": "55116800", "plugins": ["HaybaMCPToolkit", "HaybaMCPGAS", "HaybaMCPMetaSound"] }
  ]
}
```

```json
{
  "schema": 1,
  "engine": "5.8",
  "buildId": "55116800",
  "plugins": {
    "HaybaMCPToolkit": {
      "treeSha256": "…",
      "files": {
        "HaybaMCPToolkit.uplugin": "…sha256…",
        "Binaries/Win64/UnrealEditor-HaybaMCPToolkit.dll": "…",
        "Binaries/Win64/UnrealEditor.modules": "…"
      }
    }
  }
}
```

`files` lists every file (the example is truncated). `treeSha256` is the SHA256 of the UTF-8 text formed by the sorted lines `<relative/path>\t<sha256>\n`. The core computes an installed copy's tree hash the same way.

### 8.3 `latest.json` (release asset; the stable URL is `…/releases/latest/download/latest.json`)

```json
{
  "schema": 1,
  "product": "hayba",
  "version": "0.4.0",
  "tag": "v0.4.0",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "released": "2026-10-20T12:00:00Z",
  "notesUrl": "https://github.com/zajalist/hayba/releases/tag/v0.4.0",
  "minSetup": "0.4.0",
  "node": "24.14.0",
  "engines": [
    { "engine": "5.7", "buildId": "47537391" },
    { "engine": "5.8", "buildId": "55116800" }
  ],
  "assets": [
    { "kind": "payload",   "name": "hayba-0.4.0-win-x64.zip",       "url": "https://github.com/zajalist/hayba/releases/download/v0.4.0/hayba-0.4.0-win-x64.zip", "sha256": "…", "size": 52000000 },
    { "kind": "script",    "name": "install.ps1",                    "url": "…/v0.4.0/install.ps1", "sha256": "…", "size": 9000 },
    { "kind": "installer", "name": "HaybaSetup-0.4.0.exe",           "url": "…", "sha256": "…", "size": 34000000 },
    { "kind": "symbols",   "name": "hayba-0.4.0-ue5.7-symbols.zip",  "engine": "5.7", "url": "…", "sha256": "…", "size": 40000000 },
    { "kind": "symbols",   "name": "hayba-0.4.0-ue5.8-symbols.zip",  "engine": "5.8", "url": "…", "sha256": "…", "size": 40000000 }
  ]
}
```

- `installer` is absent until front door A ships.
- `minSetup` is the oldest core allowed to consume this file. An older core says "Download the new installer" instead of trying.
- Every `url` must be `https://github.com/zajalist/hayba/releases/download/...`. Consumers reject any other URL.

### 8.4 `SHA256SUMS`

GNU coreutils format: one line per asset, `<64 lowercase hex><space><space><file name>\n`, sorted by name. It covers every release asset except itself, including `latest.json`.

Who uses it:
- `update` checks the payload hash against both `latest.json` and `SHA256SUMS`.
- `install.ps1 -Version` reads its payload line.
- The download page shows the payload and installer hashes.

Manual check: `(Get-FileHash .\hayba-0.4.0-win-x64.zip -Algorithm SHA256).Hash.ToLower()`.

### 8.5 Install manifest (`%LOCALAPPDATA%\Hayba\install-manifest.json`)

```json
{
  "schema": 1,
  "product": "hayba",
  "version": "0.4.0",
  "installedAt": "2026-10-20T12:05:00Z",
  "updatedAt": "2026-10-20T12:05:00Z",
  "frontDoor": "ps1",
  "runtime": {
    "dir": "C:\\Users\\Ada\\AppData\\Local\\Programs\\Hayba",
    "children": ["node", "server", "setup", "plugins", "VERSION", "LICENSE", "THIRD_PARTY_NOTICES.txt"],
    "registry": ["HKCU\\Software\\Hayba"],
    "uninstallKey": "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Hayba",
    "state": "done"
  },
  "data": { "dir": "C:\\Users\\Ada\\AppData\\Local\\Hayba", "created": true },
  "projects": [
    {
      "uproject": "D:\\Games\\MyGame\\MyGame.uproject",
      "engine": "5.8",
      "buildId": "55116800",
      "location": "project",
      "pluginDirs": ["D:\\Games\\MyGame\\Plugins\\HaybaMCPToolkit"],
      "satellites": [],
      "version": "0.4.0",
      "treeHash": { "HaybaMCPToolkit": "…" },
      "backup": "D:\\Games\\MyGame\\Saved\\HaybaSetup\\backup\\20261020T120500Z",
      "uprojectEdited": false,
      "state": "done"
    }
  ],
  "clients": [
    { "id": "claude-code",    "method": "cli",  "exe": "C:\\Users\\Ada\\.local\\bin\\claude.exe", "scope": "user", "name": "hayba", "state": "done" },
    { "id": "claude-desktop", "method": "file", "path": "C:\\Users\\Ada\\AppData\\Roaming\\Claude\\claude_desktop_config.json", "key": "mcpServers", "name": "hayba",
      "entrySha256": "…", "backup": "C:\\Users\\Ada\\AppData\\Local\\Hayba\\backups\\20261020T120500Z\\claude-desktop\\claude_desktop_config.json", "state": "done" }
  ]
}
```

- `state` is `pending` (recorded before the write) or `done`.
- `entrySha256` is the hash of the canonical JSON of the entry we wrote. Uninstall uses it to tell the user when they have since edited the entry. The entry is still removed, and it is backed up first.
- A manifest with an unknown `schema` is refused, with exit 5: "made by a newer Hayba; use that version's uninstaller."

### 8.6 Client entries (exact JSON)

The examples use the user folder `C:\Users\Ada`. The core always writes absolute, expanded paths.

**Claude Code.** The `<json>` argument to `claude.exe mcp add-json hayba <json> --scope user`, passed as one argv element with no shell:
```json
{"type":"stdio","command":"C:\\Users\\Ada\\AppData\\Local\\Programs\\Hayba\\node\\node.exe","args":["C:\\Users\\Ada\\AppData\\Local\\Programs\\Hayba\\server\\dist\\bootstrap.js"],"env":{"HAYBA_MEMORY_DB":"C:\\Users\\Ada\\AppData\\Local\\Hayba\\memory\\hayba-memory.db","HAYBA_CODE_MODE":"on"}}
```

**Claude Desktop** (`claude_desktop_config.json`) and **Cursor** (`.cursor\mcp.json`). Only `mcpServers.hayba` is written:
```json
{
  "mcpServers": {
    "hayba": {
      "command": "C:\\Users\\Ada\\AppData\\Local\\Programs\\Hayba\\node\\node.exe",
      "args": ["C:\\Users\\Ada\\AppData\\Local\\Programs\\Hayba\\server\\dist\\bootstrap.js"],
      "env": {
        "HAYBA_MEMORY_DB": "C:\\Users\\Ada\\AppData\\Local\\Hayba\\memory\\hayba-memory.db",
        "HAYBA_CODE_MODE": "on"
      }
    }
  }
}
```

**VS Code** (`%APPDATA%\Code\User\mcp.json`). Only `servers.hayba` is written, and other top-level keys such as `inputs` are kept:
```json
{
  "servers": {
    "hayba": {
      "type": "stdio",
      "command": "C:\\Users\\Ada\\AppData\\Local\\Programs\\Hayba\\node\\node.exe",
      "args": ["C:\\Users\\Ada\\AppData\\Local\\Programs\\Hayba\\server\\dist\\bootstrap.js"],
      "env": {
        "HAYBA_MEMORY_DB": "C:\\Users\\Ada\\AppData\\Local\\Hayba\\memory\\hayba-memory.db",
        "HAYBA_CODE_MODE": "on"
      }
    }
  }
}
```

No entry sets `DASHBOARD_PORT`, `UE_TCP_PORT` or any key. `UE_TCP_PORT` stays unset so the server discovers the editor (tcp-client.ts:222-227; G11).

### 8.7 Setup core JSON result (`--json`, `--out`)

```json
{
  "schema": 1,
  "command": "install",
  "ok": true,
  "exitCode": 0,
  "version": "0.4.0",
  "previousVersion": null,
  "runtime": { "dir": "…", "action": "installed", "result": "ok", "message": null },
  "engines": [ { "id": "5.8", "root": "C:\\Program Files\\Epic Games\\UE_5.8", "version": "5.8.2", "buildId": "55116800", "supported": true, "reason": null } ],
  "projects": [ { "uproject": "…", "name": "MyGame", "engine": "5.8", "lastOpened": "2026-09-28T12:32:04", "default": true,
                  "action": "install", "result": "ok", "reason": null, "message": null } ],
  "clients": [ { "id": "claude-desktop", "label": "Claude Desktop", "detected": true, "default": true, "action": "add", "result": "ok",
                 "path": "…", "message": "Quit Claude Desktop from the system tray, then start it again.", "manualEntry": null } ],
  "doctor": { "ok": true, "checks": [ { "id": "runtime.boot", "status": "pass", "detail": "initialize 1.8 s, health ok, 0.4.0" } ] },
  "manifest": "…\\install-manifest.json",
  "log": "…\\logs\\setup-20261020T120500Z.log",
  "messages": []
}
```

With `--plan`, `result` is `"planned"` everywhere and `doctor` is `null`.

---

## 9. Release pipeline (F1, F2, F5)

### 9.1 Build host

- A self-hosted Windows machine with **Launcher** UE 5.7 and 5.8 at their standard paths. Hosted runners have no engines.
- MSVC: VS 2026 BuildTools 14.50 work for both engines. UE 5.7 prefers 14.44, and UBT only warns. `build-info.json` records the compiler; install 14.44 if it is available.
- Node 24 and `gh` authenticated for publishing.
- Engines are built **one at a time**. Building a second engine rewrites the per-user `MarketplaceRules.dll` (seen in the 5.7 spike), and two builds at once would collide on it.

### 9.2 Builder CLI

```
node installer/release/build-release.mjs --version 0.4.0 --commit <sha> --out <dir>
     [--engines 5.7,5.8] [--require-ancestor <p0-merge-sha>] [--skip-load-tests] [--publish-draft]
     [--compile-only --engines 5.7]      # the 5.7 compile gate (§10.1), about 3 min
```

`--skip-load-tests` is allowed only without `--publish-draft`.

### 9.3 Steps

| Step | What | Fails the release when |
|---|---|---|
| R0 Preconditions | The commit is reachable from `origin/main`. `--require-ancestor` holds (set to the P0 merge commit once P0 lands). Each engine exists and its BuildId matches the table. The tools are present. | any check fails |
| R1 Source | `git archive <commit>` → `<out>/src` (a clean tree, no local artefacts, no links) | |
| R2 Stamp | In `src` only: `.uplugin` `VersionName` = version, `Version` = MAJOR·10000 + MINOR·100 + PATCH; server `package.json` `version` | |
| R3 Build (F1) | For each engine: generate `<out>/host-<E>/HaybaHost.uproject` (EngineAssociation `<E>`; a trivial `HaybaHost` game module with `Target.cs` files; the three plugins **copied** into `Plugins/`), then run `"<root>\Engine\Build\BatchFiles\Build.bat" HaybaHostEditor Win64 Development -Project=<uproject> -WaitMutex -NoHotReload`. A host project, not `RunUAT BuildPlugin`: 5.7's BuildPlugin has no `-Dependencies` flag, so the satellites cannot resolve the Toolkit, and BuildPlugin writes `Config/FilterPlugin.ini` into the source tree. | UBT fails; or the number of `*.cpp.obj` files for each module ≠ the number of `.cpp` files in its `Source` (the build is non-unity, `HaybaMCPToolkit.Build.cs:16`; 147 Toolkit `.cpp` files at `dc6b4403`). This catches a "Succeeded" build that silently left out a new file. |
| R4 Assemble (F1) | For each engine and plugin, copy into `stage/hayba-<ver>/plugins/<E>/<P>/` using the layout in §9.5. Rewrite the `.uplugin` with `"Installed": true` and `"EngineVersion": "<E>.0"`. Move PDBs into `symbols/<E>/<P>/Binaries/Win64/`. Write `files.json`. | a module in the `.uplugin` has no DLL; `UnrealEditor.modules` BuildId ≠ the engine's ≠ the table's |
| R5 Node (F2) | Read `installer/release/node-version.json` `{version, zipSha256}`. Download `https://nodejs.org/dist/v<ver>/node-v<ver>-win-x64.zip` and `SHASUMS256.txt`. Require the zip hash to equal both the pinned value and the SHASUMS line. Extract **only** `node.exe` and `LICENSE` to `stage/.../node/`; npm, npx and corepack are left out. Check the Authenticode signature: `Valid` and `CN=OpenJS Foundation`. | any mismatch |
| R6 Server (F2) | In `src`: `npm ci --ignore-scripts`. If the server depends on `@hayba/brain-protocol`, build it (**dual layout**: main has no such dependency today; the brain-client branch does). Then `npm run build:server -w @hayba/mcp`, the dashboard build (`cd mcp-tools/hayba-mcp/dashboard && npm ci --ignore-scripts && npm run build`), and `npm run audit:production` (root `package.json:23`). Assemble `stage/.../server/`: stamped `package.json` without `scripts` and `devDependencies`; `hayba.agents.json`; `dist/**` without `*.test.*`, `*.map`, `*.d.ts` or `__tests__/`; `dashboard/dist/**`; `Resources/{node_catalog.json,pcgex_registry.db}` from `unreal/HaybaMCPToolkit/Resources/`. **Production closure:** `npm ls --all --omit=dev --parseable --workspace @hayba/mcp`. Copy each listed package directory, keeping its relative `node_modules` nesting. Workspace links are resolved with `realpath` and copied as real directories containing only their `package.json` `files` (for brain-protocol: `package.json` and `dist/`). Strip `*.md` (except LICENSE and NOTICE), `*.map`, `*.d.ts`, `*.ts`, and `test/ tests/ __tests__/ docs/ example/ examples/ .github/`. Generate `THIRD_PARTY_NOTICES.txt` (name, version, licence and licence text for every copied package, plus Node). **Smoke:** the doctor's `runtime.boot` probe against the stage, which catches anything the pruning broke. | build, audit or smoke fails |
| R7 Setup core | Copy `installer/setup/{hayba-setup.mjs,lib/**,hayba.ico}` → `stage/.../setup/`. Run `stage/.../node/node.exe --test installer/setup/test`. | a test fails |
| R8 Package (F5) | Write `VERSION` and `plugins/index.json`. Zip the payload (`tar.exe -a -cf hayba-<ver>-win-x64.zip hayba-<ver>`). Zip the symbols for each engine. Generate `install.ps1` from the template. Write `latest.json` and `SHA256SUMS`. With front door A: `ISCC.exe /DVersion=<ver> /DPayload=<stage> installer\inno\HaybaSetup.iss`, then sign the exe and uninstaller with a timestamp. | |
| R9 Load tests | §9.6, on every engine in the release. Results go into `build-info.json`. | any required test fails |
| R10 Publish (F5) | `gh release create v<ver> --draft` and upload the assets. The maintainer reviews the draft, then `gh release edit v<ver> --draft=false`. **Then** copy `install.ps1` to `website/install.ps1` and deploy the website. Finally check that `irm https://hayba.vercel.app/install.ps1` contains the new version and a hash that matches `SHA256SUMS`, and run the website link crawler. The order matters: the website must never point at assets that are not published yet. | |

Expected sizes (from the groundwork measurements): one engine's plugin set is about 13 MB raw; `node.exe` 91 MB; server dist 2.5 MB; production `node_modules` about 37 MB after stripping. The payload zip is about 50 MB and the LZMA installer about 33 MB. The installed footprint is about 180 MB including `plugins\`, plus about 13 MB for each project copy. The existing `v0.1.0` release has no assets *(checked with `gh release view`)*, so no downloader has to handle an older asset layout.

### 9.4 Staging layout

```
<out>/v0.4.0/
  src/                              git archive of <commit>, stamped (R1, R2)
  host-5.7/  host-5.8/              generated host projects and build output (R3)
  stage/hayba-0.4.0/                == payload root == zip top folder
    VERSION  LICENSE  THIRD_PARTY_NOTICES.txt
    node/node.exe  node/LICENSE
    server/{package.json, hayba.agents.json, dist/, node_modules/, dashboard/dist/, Resources/}
    setup/{hayba-setup.mjs, lib/, hayba.ico}
    plugins/index.json
    plugins/5.7/{files.json, HaybaMCPToolkit/, HaybaMCPGAS/, HaybaMCPMetaSound/}
    plugins/5.8/{...}
  symbols/5.7/<Plugin>/Binaries/Win64/*.pdb   symbols/5.8/...
  assets/                           exactly what R10 uploads
    hayba-0.4.0-win-x64.zip  hayba-0.4.0-ue5.7-symbols.zip  hayba-0.4.0-ue5.8-symbols.zip
    install.ps1  latest.json  SHA256SUMS  [HaybaSetup-0.4.0.exe]
  logs/                             UBT, npm, load-test logs
  build-info.json                   commit, engines, BuildIds, MSVC, Node, timings, closure size, load-test results
```

### 9.5 Plugin package layout (per engine and plugin)

This layout is taken from the Toolkit package that `RunUAT BuildPlugin` produced on UE 5.7.4 during the spike *(checked on build host)*. The 5.8 layout is OV-4.

```
<Plugin>/
  <Plugin>.uplugin                       "Installed": true, "EngineVersion": "5.7.0", VersionName stamped
  Binaries/Win64/UnrealEditor-<Module>.dll
  Binaries/Win64/UnrealEditor.modules    {"BuildId": "<engine BuildId>", "Modules": {...}}
  Source/**                              needed by UBT when a C++ project builds against an installed plugin
  Resources/**                           icons, cognitive-map/, node_catalog.json, pcgex_registry.db (Toolkit)
  Config/**                              only if it holds more than an empty FilterPlugin.ini
  Intermediate/Build/Win64/UnrealEditor/Inc/<Module>/UHT/**                 generated headers
  Intermediate/Build/Win64/x64/UnrealEditor/Development/<Module>/UnrealEditor-<Module>.lib   import library
```

Left out: `*.pdb` (they go into the symbols asset; the Toolkit's PDB is about 142 MB), all other `Intermediate/`, `Saved/`, and `Docs/`.

### 9.6 Load tests (release gate, run on the build host)

Each test starts from a fixture project zip (a Blank template, created once for each engine and stored outside the repo) unpacked into a fresh folder. Every test finishes with `doctor --json` as its last step.

| Id | Engines | Test | Pass when |
|---|---|---|---|
| L1 | each | Clean Blueprint-only project: `install --yes --project <p> --payload <stage> --clients none`, then `UnrealEditor-Cmd.exe <p> -ExecCmds="Automation RunTests Hayba;Quit" -unattended -nosplash -RenderOffscreen -log` | exit 0. The log shows the module starting with no "different engine version" or missing-module error, and no "Optional command domains unavailable". A heartbeat file appears. `/api/health` on 7821 reports the release version. The `Hayba` automation filter passes in full (63 tests at `dc6b4403`; the narrower `Hayba.MCP` filter skips files). A file-system and registry diff shows only the allowed paths (SC2). |
| L2 | each | Clean C++ project: same as L1, then `Build.bat <Proj>Editor Win64 Development -Project=<p>` | The build succeeds and the UBT log has **no** compile actions for any Hayba `.cpp` (the installed plugin is used as-is) |
| L3 | 5.8 required, 5.7 if time allows | Package the L1 project: `RunUAT BuildCookRun -project=<p> -platform=Win64 -clientconfig=Development -cook -stage -pak -archive -noP4` | Packaging succeeds. The log records whether UAT built a game target (answers OV-1). Run once before and once after G9's `TargetAllowList` and keep the fix only if it helps. |
| L4 | each | Satellites with the engine plugins off: a project whose `.uproject` sets `GameplayAbilities` and `Metasound` to `"Enabled": false`; `install --satellites gas,metasound` | The Toolkit loads. Record whether the engine plugins end up on (answers OV-2) and correct the satellite descriptions (G9c). |
| L5 | each | Upgrade and idempotency: install the previous payload (if one exists), then this one, then this one again | Projects are upgraded and backups exist. The second run of the same version is all `unchanged`, with byte-identical client files (SC3). |
| L6 | one | Uninstall scope: pre-seed an unrelated client entry, an unrelated plugin and a user memory DB; then `uninstall --yes` | Only manifest paths are removed. The unrelated items are byte-identical and the memory DB is kept (SC4). With `--remove-data`, the data dir is gone. |
| L7 | one | Developer link: `Plugins\HaybaMCPToolkit` is a junction (`mklink /J`, which needs no admin) | Result `skip` with the link message. The junction target is untouched. |
| L8 | one | Client round-trip: run `install --clients detected` under a throwaway Windows user that has Claude Code and VS Code installed | `claude mcp get hayba` reports it connected (health-checked). VS Code lists `hayba`. Uninstall removes both. |

**Before the public exe (not a gate for the tester beta):** a clean VM **without** Visual Studio, which checks "no Visual Studio" end to end; and SmartScreen and antivirus behaviour of the signed exe.

---

## 10. Plugin and server gap fixes

These go on their own branch (`fix/installer-gaps`) **after P0 lands** (§14). Binaries cut before them would bake the problems in. Each fix is small. Class-layout changes need a full rebuild, not Live Coding; after building, confirm with `test_list` that new `.cpp` files are in the binary.

**G1 — Node lookup is narrow**
- *Where:* `HaybaMCPModule.cpp:611-621` (`FindNodeExecutable`). It checks `<Plugin>/ThirdParty/node/node.exe` (:613), then the two Program Files paths (:616-617). No PATH, no version check. It is called at :497.
- *Change:* resolve in this order:
  1. `%HAYBA_HOME%\node\node.exe`;
  2. `HKCU\Software\Hayba\InstallDir` (`FWindowsPlatformMisc::QueryRegKey`) → `<InstallDir>\node\node.exe`;
  3. `<Plugin>/ThirdParty/node/node.exe`;
  4. each `node.exe` on `PATH`;
  5. the Program Files paths.

  For 1–2, read the Node version from `<dir>\VERSION` `node`. For 3–5, run `node --version` once (`FPlatformProcess::ExecProcess`, capped at 3 s) and cache the result for the session. Reject anything below 22.13.0 (OV-3) with the log line "Skipping `<path>`: Node `<v>` is older than 22.13". Log the chosen path and version. Return an absolute path. The lookup is shared with G2 in `HaybaRuntimeLocator`.
- *Acceptance:*
  - An automation test `Hayba.Installer.RuntimeLocator` with injected probes covers the order and the version rejection.
  - With the runtime installed and no system Node, the sidecar starts, and the log shows `Node: <InstallDir>\node\node.exe (24.x)`.
  - With only Node 22.12 on PATH, Node is rejected, and the panel says "Node.js 22.13 or newer not found — run the Hayba installer".

**G2 — Server lookup: add the shared runtime; launch `bootstrap.js`**
- *Where:* `HaybaMCPModule.cpp:623-666` (`GetMCPServerPath`). Every candidate ends in `dist/index.js` (:638, :654, :663). `bootstrap.ts:8-11` installs console secret redaction **before** it dynamically imports `index.js`, so launching `index.js` directly skips redaction of import-time output.
- *Change:* the order becomes:
  1. override (:626);
  2. repo dev build (:636);
  3. symlink-resolved dev build (:649-660);
  4. `<HAYBA_HOME or InstallDir>\server\dist\bootstrap.js`;
  5. `<Plugin>/ThirdParty/mcp_server/dist/bootstrap.js`.

  All candidates use `bootstrap.js`, and all are made absolute.
- *Acceptance:*
  - With the installed runtime and a project copy, the log shows "MCP server entry (installed runtime): …\bootstrap.js".
  - The dev symlink layout still resolves the repo build.
  - A secret-shaped string printed at import time comes out redacted in `HaybaSidecar.log` (together with G3).

**G3 — The sidecar runs in the wrong working directory; logs are discarded; stores are cwd-relative**
- *Where:* `FPlatformProcess::CreateProc(*NodePath, *Params, false, true, true, &ProcessID, 0, nullptr, nullptr, nullptr)` at `HaybaMCPModule.cpp:528`: the working directory is `nullptr` and there are no pipes. The environment is set at :515-524. The server resolves these stores from `process.cwd()`:
  - `tools/routing/register.ts:160-162` (tool-index cache);
  - `tools/routing/settings-watcher.ts:12-15` (`settings.json`);
  - `tools/disabled-tools-watcher.ts:14-21`;
  - `plumb/constraint-store.ts:16`, `grammar-store.ts:16`, `lesson-store.ts:24`, `profile-store.ts:16`, `study-requests.ts:19`;
  - `validator/config.ts:43`, `validator/history.ts:18`, `tools/validator/tools.ts:267`, `tools/plumb/tools.ts:68`;
  - `tools/execute-pcg-graph.ts:34`, `tools/asset-retriever/meta-tools/browse.ts:41,51`, `tools/python-run-validator-wrap.ts:29`;
  - on the brain-client branch, `chat/session-store.ts:90` (chat sessions).

  With the editor started from the Launcher, the working directory is `<Engine>/Binaries/Win64`, so these land inside the engine. They are shared across projects, and they diverge from `<Project>/Saved/HaybaMCP`, where the plugin writes.
- *Change (plugin):*
  - pass the absolute project directory as the working directory;
  - set `HAYBA_PROJECT_DIR` to the project directory;
  - set `HAYBA_LOG_FILE` = `<Project>/Saved/Logs/HaybaSidecar.log`.
- *Change (server):*
  - `bootstrap.ts` tees the already-redacted console output to `HAYBA_LOG_FILE`, keeping the previous run as `HaybaSidecar-prev.log`.
  - A new `src/paths.ts` exports `projectDir()`. It returns `HAYBA_PROJECT_DIR`; otherwise the nearest ancestor of the working directory that contains a `.uproject` (at most 8 levels, the same bound as `tcp-client.ts:175`); otherwise the G11 instance entry; otherwise `null`.
  - Every store above resolves under `projectDir()`, or under `<dataDir>\scratch` (G7) when it is `null`. The existing environment overrides keep precedence.
- *Acceptance:*
  - Start the editor from the Launcher; a file-system diff shows **no** files created under `<Engine>`.
  - A tool disabled in the panel is disabled in the sidecar.
  - `HaybaSidecar.log` exists with the startup lines.
  - A server started by Claude Desktop writes nothing into its own working directory.

**G4 — Stale satellite check and toast**
- *Where:* `HaybaMCPModule.cpp:209-248`. The list at :214-219 still names `HaybaMCPNiagara` (:216) and `HaybaMCPSequencer` (:218), which ADR-0008 removed. Any missing satellite triggers a warning and an 8-second toast (:240-246). Since the installer leaves satellites out by default, every clean install would show it.
- *Change:*
  - Check only GAS and MetaSound.
  - A satellite that is not installed at all (`!P.IsValid()`) gets one Log-level line and no toast.
  - One that is installed but disabled keeps today's warning and toast.
- *Acceptance:*
  - A clean project with only the Toolkit shows no warning and no toast.
  - With GAS installed and disabled, the toast names `gas_*` only.

**G5 — Port 7821 reuse is blind (version handshake)**
- *Where:*
  - `HaybaMCPModule.cpp:266-281` reuses whatever accepts a TCP connection on the sidecar port (:273, 0.25 s probe).
  - `/api/health` (`dashboard/api.ts:33-43`) returns no version.
  - `index.ts:67` hardcodes `v1.0.0`.
- *Change (server):*
  - `/api/health` adds `product:"hayba"`, `version` (read once from `package.json`), `pid`, `execPath` and `projectDir`.
  - The startup log uses the same version.
- *Change (plugin):* when the port is reachable, send an asynchronous `GET /api/health` (FHttpModule, 1 s timeout).
  - **Not Hayba:** warn "Port 7821 is used by another program. Change Sidecar URL in Hayba settings." Do not start.
  - **Hayba, same version and same `projectDir`:** reuse it.
  - **Otherwise:** notify "A Hayba sidecar from another version or project is running on port 7821", with **Restart sidecar** and **Ignore**. Restart terminates the PID only when `execPath` is under `InstallDir` or the plugin's `ThirdParty` (`FPlatformProcess::OpenProcess` + `TerminateProc`), then starts a new one.
- *Acceptance:*
  - An automation test covers the decision table: not-Hayba, same, version differs, project differs.
  - Manually: run an older sidecar, then open a newer editor. The notice appears, and Restart replaces the sidecar.

**G6 — `HAYBA_BRAIN_URL` passthrough**
- *Where:* nothing under `unreal/` sets it at `dc6b4403`. The server reads `process.env.HAYBA_BRAIN_URL` on the brain-client branch (`config.ts:106`).
- *Change:*
  - Add a per-project setting `BrainURL`, empty by default, stored in `GEditorPerProjectIni` beside `bAutoStartSidecar` and `SidecarEntryPath` (`HaybaMCPSettings.cpp:282-283`).
  - When it is not empty, set `HAYBA_BRAIN_URL` before `CreateProc`. It must be HTTPS, or `http://127.0.0.1` / `localhost` for development.
  - Never clear a value inherited from the user's environment.
  - The installer never sets it in v1.
- *Acceptance:* with the setting on, the sidecar logs "brain URL configured: `<origin>`". With it empty, nothing changes.

**G7 — The server writes into its own package folder**
- *Where:*
  - `config.ts:83-85`: the memory DB defaults to `<pkg>/data/hayba-memory.db`.
  - `tools/scrape-node-registry.ts:18,213,287`: the scrape writes the registry and catalog next to the shipped resource that `resolveResource` finds (`config.ts:21-39`).
- *Change:* `dataDir()` in `src/paths.ts` returns:
  1. `HAYBA_DATA_DIR`;
  2. in the dev layout (the package root has `src/` and `tsconfig.json`), today's `<pkg>/data`;
  3. otherwise `%LOCALAPPDATA%\Hayba`.

  Consequences:
  - The memory DB defaults to `<dataDir>\memory\hayba-memory.db`, the same path the installer writes into client entries. The plugin-started sidecar and the client-started servers therefore share one memory.
  - The scrape defaults to `<dataDir>\pcgex\`.
  - `resolveResource` checks `<dataDir>\pcgex\` after the environment overrides and before the shipped candidates. A user scrape then overrides shipped data without writing into the runtime.
  - The shipped DBs in `server\Resources\` are found by the existing candidate at `config.ts:29`.
- *Acceptance:*
  - With the runtime folder made read-only (`icacls /deny`), memory writes and a scrape both succeed into `%LOCALAPPDATA%\Hayba`.
  - The dev checkout behaves as before, and its tests pass.

**G8 — `engines` is too loose for `node:sqlite`**
- *Where:*
  - `mcp-tools/hayba-mcp/package.json:43-45` and root `package.json:11` say `">=22.5.0"`.
  - `node:sqlite` is loaded at module scope through `createRequire`, in `gaea/memory/hayba-memory.ts:14` and four other modules.
- *Change:*
  - Set `">=22.13.0"` (OV-3).
  - Add a guard at the top of `bootstrap.ts`, before any other import: "Hayba needs Node.js 22.13 or newer (found X). The Hayba installer includes a suitable Node." Then exit 1.
- *Acceptance:* Node 22.12 prints that message and exits 1. Node 24 boots.

**G9 — Descriptor fixes**
- *Where:*
  - `HaybaMCPToolkit.uplugin:19-25` (dependencies);
  - `HaybaMCPGAS.uplugin:19-22` and its description at :6;
  - `HaybaMCPMetaSound.uplugin:15-18` and its description at :6;
  - the satellites have no `Config/` directory.
- *Change:*
  - (a) Add `"TargetAllowList": ["Editor"]` to the dependency entries. Without it, packaging a Blueprint-only game with Hayba enabled likely needs Visual Studio *(unverified; inferred from `NativeProjects.cs`; OV-1)*. Keep this only if L3 shows it helps and does no harm.
  - (b) Give each satellite a `Config/FilterPlugin.ini`, a copy of the Toolkit's header-only file.
  - (c) The satellites say they are "Auto-disabled by UE when GameplayAbilities/Metasound is off". Enabling a satellite probably switches the engine plugin **on** instead *(unverified; OV-2)*. Reword after L4.
- *Acceptance:*
  - L3 results are recorded before and after (a).
  - The source tree is unchanged after R3 (`git status` is clean).
  - The descriptions match what L4 observed.

**G10 — Prune the server's dependencies**
- *Where:* `mcp-tools/hayba-mcp/package.json:25` (`@distube/ytdl-core`), `:27` (`cheerio`) and `:33` (`youtube-transcript-api`). Nothing imports them. The only reference is a type declaration, `src/gaea/scripts/youtube-transcript-api.d.ts:1`.
- *Change:*
  - Remove the three dependencies and the orphaned `.d.ts`.
  - The builder copies `@hayba/brain-protocol` as a real directory when present (R6).
- *Acceptance:*
  - `npm ls --omit=dev -w @hayba/mcp` no longer lists them.
  - Typecheck and tests pass.
  - The production closure size is recorded in `build-info.json`.

**G11 (proposed during verification; not in the approved ten; needs the maintainer's OK) — User-level instance registry**
- *Where:*
  - The heartbeat is written only to `<Project>/Saved/HaybaMCP/instances/<pid>.json` (`HaybaMCPModule.cpp:447-461`).
  - The server finds it by walking up from its working directory (`tcp-client.ts:149-217`), and otherwise dials 52342 (:227).
  - A server started by Claude Desktop, Cursor or VS Code has a working directory outside any project. With two editors open it always takes the first port, and it never learns the project directory, which G3 needs for settings.
- *Change:*
  - The plugin also writes the same JSON to `%LOCALAPPDATA%\Hayba\instances\<pid>.json` and deletes it on shutdown.
  - The server scans that folder after the working-directory walk. It uses the newest live entry's `port` and `project_dir`.
- *Acceptance:* with two editors open, a user-scope client connects to the most recently started editor and uses that project's settings.
- *v1 without G11:* works for the single-editor case.

### 10.1 UE 5.7 support work (Q2)

The spike ran against `dd98e537`. All 8 sites are unchanged at `dc6b4403` *(re-checked)*:

| # | Root cause | Sites | Fix |
|---|---|---|---|
| 1 | Five `EMaterialUsage` values exist only in 5.8 | `handlers/HaybaMCPMaterialHandler.cpp:2565-2569`, `Tests/HaybaMCPMaterialUsageTest.cpp:127-131` | `#if` on `ENGINE_MINOR_VERSION >= 8` around the five entries. On 5.7, the tool schema (`material-set-material-property.ts`) should say that the five keys are unavailable, or be engine-aware. |
| 2 | `UMaterial::SetUsageByFlag` is private in 5.7 | `HaybaMCPMaterialHandler.cpp:2762`, `:2778` | A shim below 5.8 that writes the public `bUsedWith*` bitfields (mirroring 5.7's own `Material.cpp` switch) |
| 3 | `RecompileMaterial` returns `void` in 5.7 | `HaybaMCPMaterialHandler.cpp:3167` | `#if`. On 5.7, read `GetMaterialResource(GMaxRHIShaderPlatform)->GetCompileErrors()`. |
| 4 | The `FJsonObject::Values` key type differs between engines | `HaybaMCPSecretRedaction.cpp:580` | A portable form: `FStringView RawKey(*Pair.Key, Pair.Key.Len())` |
| 5 | `EGetObjectsFlags` exists only in 5.8 | `handlers/HaybaMCPUILayout.cpp:198`, `Tests/HaybaMCPUIPreviewLifetimeTest.cpp:252` | Drop the argument. The default includes nested objects on both engines. |

Also:
- `#include "Runtime/Launch/Resources/Version.h"` where the guards are used.
- A **5.7 compile gate** (`build-release.mjs --compile-only --engines 5.7`, about 3 minutes) before merging plugin changes. The five breakages above arrived within two days without anyone noticing.
- The full `Hayba` automation run on both engines.

The satellites and all `.uplugin` and `Build.cs` files already build on 5.7.

---

## 11. Security

- **HTTPS only.**
  - Downloads come from `github.com` (redirects only to `objects.githubusercontent.com`) and, on the build host, `nodejs.org`.
  - `http://` URLs are refused, and so are asset URLs outside `https://github.com/zajalist/hayba/releases/download/`.
  - Certificate checks are never skipped.
- **Hash verification with two independent origins.**
  - `install.ps1` (served from the website) embeds the payload SHA256, and the payload comes from GitHub.
  - `update` requires `latest.json`, `SHA256SUMS` and the downloaded file to agree.
  - The builder pins the Node zip hash in the repo and cross-checks it against `SHASUMS256.txt`.
  - Before running it, `install.ps1` checks that `node.exe` carries a valid OpenJS Foundation Authenticode signature.
  - The payload is extracted only after its hash matches, and extracted paths are checked to stay inside the destination.
- **No admin.**
  - Everything is per user: `%LOCALAPPDATA%` and HKCU.
  - The core refuses an elevated process unless `--allow-elevated`. install.ps1 refuses outright. An elevated run can belong to a different user (over-the-shoulder UAC credentials), and it would install into that user's profile.
  - Inno runs with `PrivilegesRequired=lowest`.
- **Never overwrite a symlink or junction.**
  - Plugin directories that are links, or that sit under a linked `Plugins\`, are skipped.
  - A config file that is a symlink is written through to its target, never replaced by a regular file.
  - Every recursive delete goes through `safeRemove` (§6.12).
- **Never log keys.**
  - The core never reads provider keys; they live in the plugin's DPAPI vault.
  - Client-config writers touch only the `hayba` entry and never log or print other entries, because their `env` may hold other tools' secrets.
  - The doctor report redacts the user folder and lists only Hayba's two environment keys.
  - The sidecar log is written through `bootstrap.ts`'s console redaction (G2, G3).
- **Uninstall scope.** Only manifest paths, plus `hayba` client entries that are ours (recorded in the manifest, or pointing into `<rt>`). User data stays unless `--remove-data`. Other entries, plugins and project files are never touched.
- **Process control.** The core kills only `node.exe` processes whose image is under `<rt>\node\`. It never kills Unreal Editor or any other program.
- **Supply chain.**
  - `npm ci --ignore-scripts` from the lockfile.
  - The production closure only.
  - `audit:production` gates the release.
  - Node ships unmodified with its signature. npm and corepack are left out.
  - The setup core has no npm dependencies; `jsonc-parser` is vendored and pinned.
- **Signing.**
  - The tester beta is the unsigned one-liner (Q4).
  - The public `HaybaSetup.exe` and its uninstaller are signed with RFC 3161 timestamps.
  - Plugin DLLs do not need signing: Unreal Editor loads them, and SmartScreen does not check DLLs.
- **Privacy.** The update check is one HTTPS GET of a static file from GitHub, with no telemetry. It can be turned off (`bCheckForUpdates`).
- **Temporary files.** They go in freshly created, randomly named folders under `%TEMP%` and are deleted after use.

---

## 12. Error handling by step

| Step | Failure | User-facing message | Exit / result |
|---|---|---|---|
| Environment | Elevated | "Run the installer from a normal (non-admin) PowerShell window. Hayba installs for your user only and never needs admin rights." | 9 |
| Environment | Not x64, or an old Windows | "Hayba supports 64-bit Windows 10 (1809 or later) and Windows 11 on x64 PCs." | 9 |
| Lock | Another setup is running | "Another Hayba setup is already running (PID n). Wait for it to finish." | 3 |
| Download (ps1/update) | Network | "Couldn't download Hayba from GitHub: `<reason>`. Check your connection or proxy and try again." | 11 |
| Download | Hash mismatch | "The download does not match the published checksum. Nothing was installed. Try again later; if it keeps happening, report it." | 5 |
| Preflight | Editor running | Interactive: "Unreal Editor is running (`<projects>`). Save your work and close it, then press Enter (Ctrl+C cancels)." With `--yes`: "Close Unreal Editor and run the installer again." | 3 |
| Preflight | Our Node would not stop | "Couldn't stop a Hayba server (PID n). Close the AI apps that use Hayba and try again." | 3 |
| Preflight | 7821 foreign | Warning, §6.5 | 0 or 7 (doctor WARN) |
| Preflight | Low disk | "Hayba needs about 400 MB free on `<drive>`; `<n>` MB is free." | 6 |
| Runtime | Write or rename failed | "Couldn't install the Hayba runtime in `<dir>`: `<reason>`. Your previous installation was restored." | 6 |
| Runtime | Locked file (antivirus) | "Windows is holding `<file>` open (often antivirus scanning it). Wait a minute and run the installer again." | 6 |
| Engines | None supported | "No supported Unreal Engine found. Hayba needs Unreal Engine 5.7 or 5.8 installed from the Epic Games Launcher." | 4 (unless `--only clients`) |
| Engines | Source build | "`<root>` is built from source. Prebuilt Hayba only matches Launcher engines. Build Hayba from source for this engine: `<docs link>`." | reason on the engine |
| Engines | BuildId mismatch | "UE `<ver>` at `<root>` has build ID `<a>`, but this Hayba release was built for `<b>`. Update Hayba or the engine so they match." | 5 if explicitly requested, otherwise skip |
| Engines | Newer minor | "UE `<ver>` is newer than this Hayba release supports. Check https://hayba.vercel.app/download for a newer release." | skip |
| Projects | None selected (`--yes`) | "No Unreal project selected. Run again with -Project `<path to .uproject>`." | 4 |
| Projects | Engine unknown | "Can't tell which engine `<name>` uses (EngineAssociation '`<x>`'). Open it once in Unreal Editor, or pass -Engine." | skip |
| Plugin copy | Link | "Left `<path>` alone: it is a link to a developer checkout." | skip |
| Plugin copy | Read-only | §6.9 | failed → 7 |
| Plugin copy | Copy or swap failed | "Couldn't update Hayba in `<project>`: `<reason>`. The previous version was restored." | failed → 7 |
| Plugin copy | Engine folder not writable (Advanced) | "Can't write to `<path>`. Use the default project install instead." | failed → 7 |
| Clients | Unparseable config | §6.10.1 | failed → 7 |
| Clients | Claude Code shim only | "Claude Code is installed as a script, which the installer does not run. Paste this in a terminal:" plus the command | manual (0) |
| Clients | Managed by the organisation | §6.10.2 | manual (0) |
| Clients | CLI error | "`claude mcp add-json` failed (exit n): `<first stderr line>`." plus the manual command | failed → 7 |
| Clients | File locked | §6.10.1 step 7 | failed → 7 |
| Doctor | Any FAIL | The check's fix text (§6.11) plus "Copy the report below into an issue if you need help." | install 7, doctor 8 |
| Uninstall | No manifest | "No Hayba installation record found for this user. Nothing was removed." | 4 |
| Uninstall | Path changed (now a link, or not ours) | "Left `<path>` alone: it changed since Hayba installed it." | continue |
| Update | Up to date | "Hayba `<ver>` is the latest version." | 0 |
| Update | `minSetup` too new | "This update needs the new installer. Download it from https://hayba.vercel.app/download." | 5 |
| Any | Unexpected exception | "Something went wrong inside the installer. Nothing unsafe was left half-done; details are in `<log>`. Please report it with that file." | 1 |

Every message names what happened, what state things were left in, and the next action. No message contains a stack trace; stack traces go to the log only.

---

## 13. Testing strategy

**Setup-core unit tests** (`node --test`, run with the bundled Node; no npm dependencies):

- **Fakes.**
  - `MemFs`: paths are case-insensitive. It supports links (`lstat().isSymbolicLink()`), a read-only mode bit, fault injection (fail the Nth rename or write with EPERM, EBUSY, EXDEV or ENOSPC), and `realpath` through links.
  - `FakeReg`: a map of key → values and subkeys.
  - `FakeProc`: scripted process lists and `exec` results.
  - `FakeNet`: canned `latest.json`, `SHA256SUMS`, health responses and download bytes.
  - `FakeUi`: scripted answers.
- **Engine detection fixtures:**
  - `LauncherInstalled.dat` with 5.7 and 5.8 plus `FabPlugin_` and `QuixelBridge_` items;
  - an HKCU Builds GUID custom build;
  - stale HKLM keys;
  - `SourceDistribution.txt`;
  - 5.9 (newer minor) and 5.6 (older);
  - missing `Engine\Build`;
  - a BuildId mismatch;
  - `Build.version` / `.modules` disagreement (a warning).
- **Project detection fixtures:**
  - `EditorSettings.ini` with `RecentlyOpenedProjectFiles` (with `LastOpenTime`) and `CreatedProjectPaths`;
  - a source-built engine's `Engine\Saved\Config\...` ini;
  - a `Personal` shell folder redirected to OneDrive (`%USERPROFILE%\OneDrive\Documents`);
  - `EngineAssociation` as a version, a GUID, empty, and unknown;
  - `.uproject` files with a BOM;
  - a project with `Plugins\HaybaMCPToolkit` as a link, as a copy, and absent.
- **Config writers** (each client), all asserted byte-for-byte:
  - missing file and missing folder;
  - `{}`;
  - a UTF-8 BOM (kept);
  - CRLF (kept);
  - comments and trailing commas (JSONC; kept);
  - unknown top-level keys and other servers (byte-identical outside `hayba`);
  - an existing identical `hayba` (no write, no backup);
  - an existing different `hayba` (replaced, backed up);
  - invalid JSON (refused, untouched);
  - a root that is not an object (refused);
  - a symlinked config (the target is written, the link is kept);
  - EBUSY then success (retried);
  - an MSIX shadow present (preferred) or absent (`%APPDATA%` used);
  - two MSIX packages (the newest file wins);
  - VS Code using `servers` with `type:"stdio"`.
- **Claude Code writer:**
  - `claude.exe` on PATH;
  - only a `.cmd` shim (manual);
  - the native path fallback;
  - `managed-mcp.json` (blocked);
  - an existing identical entry (no CLI call);
  - a different entry (remove, then add);
  - a project-scope override (warning).
- **Idempotency property:** `apply` twice gives `unchanged` the second time, and the file is byte-identical after the second run.
- **Plugin copy:** link refusal (`Plugins` or the plugin directory), read-only refusal, BuildId refusal, `unchanged` when the tree hash matches, rollback when the Nth rename fails (the tree equals the original), backup pruning (keeps 2), stale Niagara/Sequencer moved to backup, the locked-set upgrade of existing satellites.
- **Runtime swap:** rollback at each rename index; cleanup of leftover `.old` and `.staging` folders; `VERSION` is written last.
- **Manifest:** save → load round-trip equality; intent recorded before the write (a crash injected after the intent still leaves an uninstallable record); unknown schema refused.
- **Uninstall scope:** only recorded paths are removed; an unrecorded `hayba` entry pointing outside `<rt>` is kept; a path that became a link is skipped; `safeRemove` rejects paths outside the allowed roots (it throws and deletes nothing); `--remove-data` behaviour.
- **CLI:** every flag; unknown flag → 2; the exit-code table (each code produced by a scripted scenario); `--plan` writes nothing but the `--out` file (the MemFs diff shows only that file); `--json` result snapshots.
- **Update:** hash agreement (all three), disagreement → 5, `minSetup`, a URL outside the allowed prefix is rejected, and the new core is run with the passed-through flags.
- **Doctor:** the renderer redacts the user folder and never prints other entries (SC7); the check matrix.

**Real Windows file-system tests** (any Windows machine, including a hosted Windows runner; no engine needed):
- junction detection with `mklink /J` (needs no admin);
- atomic `rename` over an existing file;
- the read-only attribute;
- `reg.exe` against `HKCU\Software\HaybaTest-<rand>` (always cleaned up);
- `tar.exe` extraction and the check that paths stay inside the destination;
- the elevated-process check.

**install.ps1 tests:** run under both `powershell.exe` 5.1 and `pwsh` 7 with `-PayloadPath` pointing at a local zip:
- the good hash → exit 0;
- a bad hash → 5, nothing written;
- the PowerShell session survives (no `exit`);
- a Constrained Language Mode simulation → 9.

**Plugin automation tests** (`Hayba` filter):
- `Hayba.Installer.RuntimeLocator` (G1 and G2 ordering, version rejection);
- the G4 no-toast case;
- the G5 decision table;
- update-notice version comparison and `notesUrl` validation;
- the ClientConnect result parsing.

**Load tests:** §9.6, as the release gate.

**Doctor:** at the end of every install, and as the last step of every load test.

---

## 14. Sequencing and dependencies

| Stage | Work | Depends on | Can start early |
|---|---|---|---|
| S0 | **P0 safety train lands on main.** Installable binaries must contain it, because handing pre-P0 binaries to strangers ships known editor crashes. | — | — |
| S1 | Gap fixes G1–G10 (and G11 if approved) on `fix/installer-gaps`. The 5.7 guards and the 5.7 compile gate (§10.1). | S0. Coordinate with the lanes that touch `HaybaMCPModule.cpp`. | The design of the 5.7 guards. Start **signing procurement** here: certificate lead time is the longest pole for S4. |
| S2 | Release builder (F1, F2, F5), load tests L1–L7 on both engines. First internal payload. | S1. `@hayba/brain-protocol` is handled by R6's dual-layout staging: releases can be cut from main before or after the brain-client branch merges, and the load tests cover whichever layout ships. | A builder skeleton; `node-version.json`. |
| S3 | Setup core + `install.ps1` → **tester beta** (unsigned one-liner) for invited testers. `website/install.ps1` and a short "Install (beta)" docs section. | S2 | The setup-core modules and unit tests with fakes (pure JS, no plugin dependency) |
| S4 | Inno shell + signing + the **website download page** → public release. | S3, the certificate, the clean-VM checks (§9.6) | The Inno page prototype |
| S5 | The in-editor "Connect AI client" command and the update notice, in a plugin release | S2 (the core exists in the runtime) | Recommended to pull the update notice into S1 (§7.3) |

**Download page** (`website/download/`):
- a button to the latest `HaybaSetup.exe` (from S4);
- the SHA256;
- the one-liner with a copy button;
- a SmartScreen note while the installer is unsigned;
- troubleshooting (`doctor`);
- uninstall steps;
- the text "Unreal Engine 5.7+". If Q2's fallback triggers, it states "Unreal Engine 5.8 in this release; 5.7 from source".

The page names no other products except the supported AI apps. Deploy with the clean-worktree recipe, then run the link crawler.

**Docs:**
- Replace the clone-and-symlink guide with the installer, and keep build-from-source as an appendix.
- `docs/getting-started.md:63-64` says `uv sync --extra gpu` and "listens on :7821". CLIP needs `--extra embed`. The port text should change to 7822 when the brain-client port move lands; on main the visual server still defaults to 7821 (`server.py:97`, `tools/visual/sidecar-client.ts:1`).

**Licensing:** ship Node's `LICENSE` and `THIRD_PARTY_NOTICES.txt` (R6).

---

## 15. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| SmartScreen "Unknown publisher"; antivirus flags a bundle carrying `node.exe` | Extra clicks; blocked installs | Beta via the one-liner. Sign before the public exe. Ship Node unmodified with its OpenJS signature. The doctor and the download page explain the prompt. Submit false positives to the vendors. |
| File locks: the editor, a client-started server, or antivirus | Failed upgrades | Preflight closes and stops only what is ours. Renames are retried with backoff. Rollback. Clear messages. |
| Projects under version control (Perforce makes files read-only) | Failed copies | Detect read-only files and refuse per project, with a check-out hint. Never touch VCS. |
| Version skew between the shared runtime and an older project copy | Confusing behaviour | Upgrade every manifest project together. The G5 handshake notice. Doctor warns on skew. |
| The 5.7 code drifts again on main | 5.7 builds break at release time | The 5.7 compile gate (§10.1). R3 builds every engine. |
| 5.7 runtime differences not seen by the compiler (Python templates, reflection by name, `TryGetBool`) | 5.7 users hit tool errors | A full `Hayba` automation run on 5.7 (L1). The Q2 fallback rule. |
| An engine hotfix changes `CompatibleChangelist` / BuildId | The prebuilt plugin no longer matches | Refuse by BuildId with a clear message. `latest.json` lists BuildIds per engine. Rebuild on hotfixes (checked each release). |
| AI-app config formats or paths change | Entries land in the wrong place | Writers are small and isolated. The doctor checks that entries resolve. Fixtures are pinned. The paths were checked on the build host at design time. |
| The MSIX Claude shadow-copy semantics differ from what we expect | The entry is not loaded | Prefer the existing shadow file. L8-style manual check on an MSIX install (OV-11). |
| Several server processes share the memory DB | `SQLITE_BUSY` | A busy timeout in the memory store (checked in OV-13). |
| Install time dominated by file count (thousands of `node_modules` files and antivirus scanning) | Slow installs | Measure in L1. If needed, bundle the server into a few files later. Not in v1. |
| `irm \| iex` distrust or blocking (CLM, AMSI) | Some testers cannot use the one-liner | CLM is detected with guidance. Manual zip download + hash check is documented. The signed exe follows. |
| `hayba.app` is not registered | A dead URL in copy | Use only `hayba.vercel.app` and GitHub Release URLs. |
| Satellites switch engine plugins on | Surprise changes to users' projects | Satellites are off by default. L4 determines the behaviour and the descriptions say so (G9c). |
| The build host is a single machine | A release is blocked when it is down | The builder is a script with a documented host setup. Any machine with both Launcher engines can run it. |

---

## 16. Open verifications

| # | Item | Status | How it will be checked |
|---|---|---|---|
| OV-1 | Packaging a Blueprint-only **game** with Hayba enabled needs Visual Studio, and `"TargetAllowList": ["Editor"]` removes that need | *(unverified; inferred from `NativeProjects.cs`)* | L3 before and after G9a: check in the BuildCookRun log whether UAT builds a game target. Confirm on the clean VM without Visual Studio. |
| OV-2 | Enabling a satellite switches GameplayAbilities or Metasound **on** in a project that had them off | *(unverified)* | L4, then fix the satellite descriptions (G9c) |
| OV-3 | `node:sqlite` loads without a flag from Node 22.13.0 | *(from memory, verify)* | On the build host: `node -e "require('node:sqlite')"` with portable zips of 22.12.0 and 22.13.0. Set G8's floor from the result. |
| OV-4 | UBT and BuildPlugin package layout on **5.8** (5.7 checked, §9.5) | open | The first R3/R4 run on 5.8: diff against the 5.7 layout, then L2 (a C++ project links against the installed plugin) |
| OV-5 | Signing: Azure Trusted Signing eligibility and prices; OV-on-cloud-HSM prices; whether EV still gives instant SmartScreen reputation | *(from memory, verify)* | Check the vendor pages and eligibility at S1, and decide before S4 |
| OV-6 | Engine-folder (Advanced) installs need `.uproject` enable entries, and `EnabledByDefault` is not honoured for Marketplace-folder plugins | open (brief claim) | A load-test variant of L1 with `--plugin-location engine`, with and without the `.uproject` edit |
| OV-7 | The Fab requirements were read from a snapshot | *(unverified; out of v1)* | Re-read the live page before any Fab work (Q5) |
| OV-8 | Vercel serves `install.ps1` so that `irm` returns a string in Windows PowerShell 5.1 and PowerShell 7 | open | After the first deploy: `irm` in both shells. If needed, add a `vercel.json` header `Content-Type: text/plain; charset=utf-8` for `/install.ps1`. |
| OV-9 | The pinned Node zip's `node.exe` is signed `CN=OpenJS Foundation` | checked for the 24.14.0 MSI binary on the build host; open for the pinned zip | R5 asserts it on every build |
| OV-10 | `claude mcp add-json` behaviour when `hayba` already exists in user scope (error or overwrite) | open (the flags themselves are checked) | Run in a throwaway profile (`USERPROFILE` pointed at a temp folder); pin the remove-then-add path from the result |
| OV-11 | MSIX Claude Desktop reads `%APPDATA%\Claude\claude_desktop_config.json` when no shadow copy exists, and reads the shadow copy when it does | open | A manual check on an MSIX install: write, quit from the tray, restart, and confirm the server is listed. Test both states. |
| OV-12 | VS Code and Cursor pick up `mcp.json` changes without a restart | open | Manual check; adjust the "after" messages |
| OV-13 | Concurrent `DatabaseSync` access to one memory DB from several server processes | open | A stress test: two servers writing memory in a loop; add a busy timeout if `SQLITE_BUSY` appears |
| OV-14 | A server started by an AI client, with no editor running, answers MCP `initialize` promptly (the doctor's boot probe relies on it) | open | R6 smoke, and the first doctor run |
| OV-15 | `tar.exe -a -cf x.zip` output extracts correctly with `Expand-Archive` (5.1), `tar.exe`, and Inno | open | R8 round-trip test |
| OV-16 | Windows Defender / SmartScreen behaviour on the signed exe with the embedded `node.exe` | open | The pre-public clean-VM pass (§9.6) |

---

## Appendix A — Source facts this spec relies on

| Fact | Where |
|---|---|
| Plugin base dir = `IPluginManager::FindPlugin("HaybaMCPToolkit")->GetBaseDir()` | `HaybaMCPModule.cpp:146` |
| Node lookup: ThirdParty, then Program Files; no PATH or version check | `HaybaMCPModule.cpp:611-621` |
| Server lookup: override → dev → symlink-resolved dev (`GetFilenameOnDisk`) → ThirdParty; all `dist/index.js` | `HaybaMCPModule.cpp:623-666` |
| Sidecar started with no working directory and no pipes | `HaybaMCPModule.cpp:528` |
| `DASHBOARD_PORT` and `UE_TCP_PORT` set from settings; PLUMB stores pointed at `<Project>/.scratch` | `HaybaMCPModule.cpp:514-524` |
| Satellite check still lists Niagara and Sequencer; 8 s toast | `HaybaMCPModule.cpp:209-248` |
| Sidecar reuse is a TCP probe only | `HaybaMCPModule.cpp:266-281` |
| Editor TCP port walk 52342–52350; heartbeat at `Saved/HaybaMCP/instances/<pid>.json` | `HaybaMCPModule.cpp:425-461` |
| `SidecarURL` default `http://localhost:7821`; `bAutoStartSidecar`; `SidecarEntryPath` | `HaybaMCPSettings.h:101-108`, `HaybaMCPSettings.cpp:282-283` |
| Non-unity build; HTTP module already a dependency | `HaybaMCPToolkit.Build.cs:16`, `:41` |
| `.uplugin` dependencies; `Installed: false`; no `EngineVersion` pin | `HaybaMCPToolkit.uplugin:11,19-25`; `HaybaMCPGAS.uplugin:11,19-22`; `HaybaMCPMetaSound.uplugin:11,15-18` |
| `bootstrap.ts` installs redaction, then dynamically imports `index.js` | `mcp-tools/hayba-mcp/src/bootstrap.ts:8-11` |
| `resolveResource` candidates; `<pkg>/Resources` at candidate 2 | `config.ts:21-39` (`:29`) |
| Memory DB default in the package folder | `config.ts:83-85` |
| Code Mode is on unless `HAYBA_CODE_MODE=off` | `config.ts:74` |
| Client-started dashboard defaults to 52360; skipped on EADDRINUSE | `config.ts:51`; `dashboard/server.ts:96-104` |
| `/api/health` has no version; hardcoded `v1.0.0` log | `dashboard/api.ts:33-43`; `index.ts:67` |
| Editor discovery: walk up from the working directory, else `UE_TCP_PORT`, else 52342 | `tcp-client.ts:149-227` |
| `engines: ">=22.5.0"`; unused dependencies | `mcp-tools/hayba-mcp/package.json:25,27,33,43-45`; root `package.json:11` |
| `node:sqlite` loaded at module scope | `gaea/memory/hayba-memory.ts:14` (+4 modules) |
| `@hayba/brain-protocol` only on the brain-client branch (66 commits ahead of `origin/main`) | `feat/hayba-brain-client:mcp-tools/hayba-mcp/package.json` |
| `HAYBA_BRAIN_URL` read by the server; chat sessions cwd-relative | `feat/hayba-brain-client:config.ts:106`, `chat/session-store.ts:90` |
| Website is static, no build, git auto-deploy off | `vercel.json` |
| Release `v0.1.0` has no assets | `gh release view v0.1.0` |
| Launcher BuildId = `CompatibleChangelist` (5.7.4 → 47537391, 5.8.2 → 55116800); no `SourceDistribution.txt` | build host engines |
| `Marketplace` folder ACL `BUILTIN\Users:(I)(OI)(CI)(F)` | build host, UE 5.8 |
| Node `lstat` reports a junction as a symbolic link | build host, Node 24.14.0 |
| `code --add-mcp`, `cursor --add-mcp`, `claude mcp add-json … -s user`, `claude mcp remove … -s user` exist; `claude.exe` at `%USERPROFILE%\.local\bin` | build host, Claude Code 2.1.283 |
| `node.exe` signer `CN=OpenJS Foundation` | build host, 24.14.0 |
| `EditorSettings.ini` recent-project line format with `LastOpenTime` | build host, 5.8 |
