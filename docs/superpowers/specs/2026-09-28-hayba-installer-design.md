# Hayba Installer — Design

**Date:** 2026-09-28
**Status:** Approved design (maintainer "go", 2026-09-28), revised after review the same day; awaiting the first implementation plan (§14)
**Branch / base:** `feat/installer`. Citations are re-baselined on `origin/main` at `a5ceaa40` (the `feat/hayba-brain-client` merge, #431), 73 commits after the original base `dc6b4403`.
**Scope:** Windows only. Public copy says "Unreal Engine 5.7+".

All `file:line` citations refer to `a5ceaa40` unless another commit is named. The first plan starts from the P0 merge commit once it lands, and its first task re-checks every citation and re-runs the 5.7 compile gate on that base (§14). Facts checked on the build host are marked *(checked on build host)*. Claims that still need a live check are marked *(unverified)* and are listed in §16.

---

## 1. Summary

Installing Hayba today takes 9 steps and needs Git, Node, Visual Studio, and admin rights or Developer Mode: clone, `npm install`, build, symlink the plugin into the project, regenerate project files, compile, then edit every AI client's JSON by hand. This design replaces that with **one command** now and **three clicks** later:

- **One setup core.** `hayba-setup.mjs` is a dependency-free Node ESM program. It runs on a bundled, unmodified Node 24 LTS `node.exe`, and it does all the work: preflight, per-user runtime install, engine and project detection, plugin copy, AI client registration, doctor, manifest, uninstall and update.
- **Front door B (ships first, for testers).** `irm https://hayba.vercel.app/install.ps1 | iex` downloads the release payload, verifies its SHA256, and runs the core with defaults.
- **Front door A (later, for the public).** `HaybaSetup.exe` is a per-user Inno Setup installer with one page. It carries the same payload and runs the same core. It needs a code-signing certificate.
- **In the editor.** A "Connect AI client" command reuses the core to register clients, and an update notice reads `latest.json`.
- **Release pipeline.** A self-hosted builder compiles the plugins for each engine from one commit, stages the runtime, and publishes GitHub Release assets with `SHA256SUMS` and `latest.json`. The website carries a second copy of `latest.json`, so every hash check uses two origins (§11).
- **Plugin and server gap fixes first.** Ten small fixes (§10) make the prebuilt binaries installable. G5 also sets the compatibility contract between the shared runtime and each project's plugin copy.
- **Five delivery phases** (§14). The first implementation plan covers Phases 1–3 and ends with the tester beta.

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

- The Python visual add-on (port 7822; torch; 1–2 GB of weights).
- Pro sign-in. v1 is bring-your-own-key only. The only related v1 item is the `HAYBA_BRAIN_URL` passthrough (G6), which the installer does not set.
- A user-level editor registry for several open editors (G11, out of v1). With one editor open, a client-started server finds it; with several, it connects to the first TCP port.
- A Fab listing (Q5), an npm CLI, and a `.mcpb` bundle.
- macOS and Linux. Windows on ARM64.
- Engines built from source. Detection refuses them and links to the build-from-source guide.
- A silent background self-updater (Q6: opt-in, later).
- Automatic registration of Windsurf/Devin and Codex (next release).

### 2.3 Success criteria

| # | Criterion | How it is checked |
|---|---|---|
| SC1 | A clean Windows 11 user account with a Launcher engine (5.8, and 5.7 per Q2) and no Node, Git or Visual Studio runs the one-liner. It finishes with doctor all-pass. Opening the project loads Hayba with no rebuild prompt. The chat panel connects, and Claude Code lists `hayba` as connected. | Load tests L1 and L8 (§9.6) |
| SC2 | No UAC prompt, and no link created. Files are written only under: the runtime dir, the data dir, the selected projects' `Plugins/` and `Saved/HaybaSetup/`, the selected client config files, and `HKCU\Software\Hayba` (plus the uninstall key for the one-liner path, §5.3). After G7, a running server writes nothing under `%USERPROFILE%\.hayba\` or its own package folder. | File-system and registry diff before and after, in L1 |
| SC3 | Re-running the same version exits 0. Client config files stay byte-identical, and plugin copies are left in place (their tree hash matches). | L5, plus unit tests |
| SC4 | Uninstall removes exactly the manifest's paths, our `hayba` client entries and our config backups. Other client entries and unrelated plugins stay byte-identical. Memory and logs are kept unless `--remove-data` is given. | L6, plus unit tests |
| SC5 | Signed exe: 3 clicks from the download page to installed (Download, open, Install) once the certificate has SmartScreen reputation. A new certificate shows a SmartScreen prompt until then. The finish page only reports. | Manual check before the public launch; the launch checklist records the click count actually observed |
| SC6 | Every required cell of the load-test matrix (§9.6) passes before the release is published. | Release builder gate R9 (automated cells) plus the recorded manual checklist (L8) |
| SC7 | The doctor report contains no Windows user name (in any path, on any drive, or in a OneDrive folder name), no provider keys, and no other MCP server entries. | Unit test on the report renderer |

---

## 3. Decisions (settled 2026-09-28)

| Q | Decision |
|---|---|
| Q1 Plugin location | Default `<Project>/Plugins/`, one copy per project. `<Engine>/Engine/Plugins/Marketplace/` is available under **Advanced** only. |
| Q2 5.7 binaries | Rule: if the version guards take a few days or less, ship both engines from one commit. Otherwise installer v1 ships 5.8 only and the download page says so. **Spike result:** main misses compiling on 5.7 by 5 root causes at 8 sites (listed in §10.1). The spike's independent check revised the estimate to **2.5–3 dev-days, up to 4** if the 5.7 runtime run needs triage. That is still "a few days", so **v1 ships 5.7 and 5.8 from one commit**. The five files that hold the 8 sites have no changes between `dc6b4403` and `a5ceaa40` (`git diff` is empty), but 54 other files under `unreal/` changed, so the rule counts as met only after the 5.7 compile gate passes on the first plan's base (§14, Phase 1 task 1). Fallback trigger: the `Hayba` automation run plus the 5.7 tool sweep (§10.1) find problems that can't be fixed in about a day. Then v1 ships 5.8 only, `plugins/index.json` and `latest.json` list 5.8 only, and the download page shows the one fallback string `FALLBACK_57`: "This release supports Unreal Engine 5.8. For Unreal Engine 5.7, build Hayba from source." |
| Q3 Clients | Auto-configure Claude Code, Claude Desktop, Cursor and VS Code, pre-ticked when detected. Windsurf/Devin and Codex come in the next release. |
| Q4 Signing | The tester beta is the unsigned one-liner. Before the public exe: Azure Trusted Signing if Hayba is eligible, otherwise an OV certificate on a cloud HSM. |
| Q5 Fab | Only after installer v1 ships and the satellites are folded into the Toolkit as optional modules. |
| Q6 Updates | Re-run the installer or the one-liner. The editor shows an update-available notice from `latest.json` plus the version handshake (G5). An opt-in self-updater comes later. |
| Q7 Release channel (review) | Tester-beta builds are normal `0.x` GitHub releases, not prereleases, so GitHub's `latest` URL resolves. `update`, `install.ps1 -Version` and the update notice read `latest.json` from the website (`https://hayba.vercel.app/latest.json`) and check hashes against the release's `SHA256SUMS` on GitHub (§11). |
| Q8 First version (review) | `0.4.0`. It is above the existing `v0.1.0` tag and the `.uplugin`'s current `0.3.0`. |
| Q9 G11 (review) | Out of v1. v1 supports one open editor per user for client-started servers. |

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

The website (`hayba.vercel.app`) also serves `install.ps1`, `latest.json`, and `releases/v<ver>.json` (a copy of each release's `latest.json`). These are the second origin for every hash check (§11).

At run time, the editor plugin finds the shared runtime through `HKCU\Software\Hayba\InstallDir` (G1, G2) and starts the chat sidecar from it on port 7821. AI clients start the same server over stdio, using the absolute `node.exe` and `dist\bootstrap.js` paths written into their configs. The runtime is always the newest version on the machine, while project copies can lag behind. The G5 contract (`minPlugin` and a protocol number) makes an incompatible pair fail with a clear message instead of calling commands the plugin lacks.

---

## 5. On-disk layout

### 5.1 Runtime: `%LOCALAPPDATA%\Programs\Hayba\` (per user, installed once)

```
%LOCALAPPDATA%\Programs\Hayba\
  VERSION                     JSON, §8.1 (deleted first and written last; it marks a finished swap)
  runtime-files.json          {path: sha256} for every file outside plugins\ (§8.2)
  LICENSE                     Hayba (MIT)
  THIRD_PARTY_NOTICES.txt     production npm packages + Node
  node\node.exe               official Node 24 LTS win-x64, unmodified, OpenJS-signed
  node\LICENSE
  server\package.json         version stamped; no scripts, no devDependencies
  server\hayba.agents.json    read from the package root (agent-registry.ts:26-28)
  server\dist\**              build:server output, without tests, .map or .d.ts
  server\node_modules\**      production closure; @hayba/brain-protocol as a real directory
  server\dashboard\dist\**    found by dashboard/server.ts:25
  server\Resources\node_catalog.json, pcgex_registry.db   found by config.ts:29
  setup\hayba-setup.mjs, setup\lib\**, setup\hayba.ico
  plugins\index.json          §8.2
  plugins\<engine>\files.json §8.2
  plugins\<engine>\HaybaMCPToolkit\**, HaybaMCPGAS\**, HaybaMCPMetaSound\**
  unins000.exe, unins000.dat  only when installed by HaybaSetup.exe
```

The approved layout listed `{node, server, setup, VERSION}`. This spec adds `plugins\`, a copy of the per-engine plugin sets (about 26 MB for two engines). With it, `install --only projects --project <p>`, run from `<rt>` with `<rt>` as the payload (§6.6), adds Hayba to another project or repairs a broken copy without downloading again. Doctor's fix text for a broken copy is that command. It also adds the licence files and `runtime-files.json`.

Temporary siblings `.staging-*` and `.old-*` exist only while a swap runs. At start, the core first finishes or reverts any swap the manifest records as pending, and only then deletes leftovers (§6.6).

### 5.2 Data: `%LOCALAPPDATA%\Hayba\` (per user; memory and logs kept on uninstall unless `--remove-data`)

```
%LOCALAPPDATA%\Hayba\
  install-manifest.json       §8.5
  setup.lock                  held while a setup command runs (pid and process start time inside, §6.3)
  memory\hayba-memory.db      HAYBA_MEMORY_DB in client entries; also the G7 default (WAL mode)
  pcgex\                      user-scraped registry and catalog (G7)
  docs\ue-docs-5.7.sqlite     default HAYBA_UE_DOCS_DB, so a runtime swap never wipes it (G7)
  conventions.json, projects\, default\, cache\
                              formerly under %USERPROFILE%\.hayba\ (G7; the old folder is still read as a fallback)
  scratch\                    per-project stores when no project is known (G3)
  logs\setup-<UTC>.log        last 20 kept
  backups\<UTC>\<client-id>\<file>   client config originals, before our first edit in that run;
                              the last 3 per client are kept, and uninstall deletes them (§6.12)
```

The config backups can hold other tools' API keys, because they are byte-for-byte copies. That is why they are pruned and why uninstall removes them by default.

### 5.3 Registry (HKCU only)

| Key | Values | Writer |
|---|---|---|
| `HKCU\Software\Hayba` | `InstallDir` (REG_SZ, absolute runtime dir), `Version` (REG_SZ) | core, runtime step |
| `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Hayba` | `DisplayName`=Hayba, `DisplayVersion`, `Publisher`=Hayba, `InstallLocation`, `DisplayIcon`=`setup\hayba.ico`, `UninstallString`=`"<rt>\node\node.exe" "<rt>\setup\hayba-setup.mjs" uninstall --front-door ps1`, `NoModify`=1, `NoRepair`=1, `EstimatedSize` | core, only with `--front-door ps1`, and only when `{<AppId>}_is1` does not exist |
| `...\Uninstall\{<AppId>}_is1` | Inno's own entry | Inno, front door A only. |

Only one entry shows in Apps & features:
- `--front-door inno` deletes the ps1 key if we own it.
- `--front-door ps1` skips the ps1 key when the Inno key exists (the one-liner run after an Inno install).
- Every runtime step that changes the version, including one started by `update`, sets `DisplayVersion` in whichever key exists.

### 5.4 Per project

```
<Project>\Plugins\HaybaMCPToolkit\       real directory (never a link); Installed:true build
<Project>\Plugins\HaybaMCPGAS\           only when ticked, or already present
<Project>\Plugins\HaybaMCPMetaSound\     only when ticked, or already present
<Project>\Saved\HaybaSetup\s-<ver>\      staging, during a copy only (short name: long-path budget, §6.9)
<Project>\Saved\HaybaSetup\backup\<UTC>\   the previous copy; the last 2 are kept
<Project>\Saved\HaybaSetup\rm-<rand>\     uninstall only: renamed here, then deleted (§6.12)
<Project>\Saved\Logs\HaybaSidecar.log    written by the sidecar (G3)
```

Staging, backups and removals live under `Saved\`, not `Plugins\`. UE scans `Plugins\` for `.uplugin` files, so a backup there would register a duplicate plugin. `Saved\` is on the same volume as `Plugins\`, so a swap or a removal is a rename, never a cross-volume move.

With the Advanced engine location, the copy goes to `<Engine>\Engine\Plugins\Marketplace\HaybaMCPToolkit\`, and staging, backups and removals go to `<Engine>\Engine\Saved\HaybaSetup\`. Each selected `.uproject` gets `{ "Name": "HaybaMCPToolkit", "Enabled": true }`, and its original is backed up.

### 5.5 Ports

| Port | Owner | Notes |
|---|---|---|
| 52342–52350 | Editor TCP listener; the first free port wins | HaybaMCPModule.cpp:432-433 |
| 7821 | Chat sidecar started by the plugin | `DASHBOARD_PORT` is set from `SidecarURL` (HaybaMCPModule.cpp:521-522) |
| 7822 | Visual sidecar (Python add-on, not installed by v1) | `addons/visual-embeddings/.../server.py:97` and `tools/visual/sidecar-client.ts:1`. Before the brain-client merge it defaulted to 7821 and collided with the chat sidecar. |
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
 *   proc: ProcPort,    // list(imageName) -> [{pid, ppid, exe, cmdline, created}]; self() -> {pid, ancestors[]};
 *                      // kill(pid); exec(file,args,opts) -> {code,stdout,stderr}; spawnDetached(file,args,opts) -> pid
 *   net: NetPort,      // httpGet(url,{timeoutMs}) -> {status, body, finalUrl}; download(url,file,{timeoutMs}) -> {size, finalUrl};
 *                      // tcpListener(port) -> {pid, image}|null
 *   env: Record<string,string>, now: () => Date, rand: () => string,
 *   ui: UiPort,        // isTTY, prompt, choose, confirm, progress(step,pct,msg), info/warn/error
 *   log: LogPort,
 *   roots: { runtimeDir, dataDir, registryRoot }   // real defaults; overridable for tests only (§6.2)
 * }} Ctx */
```

**The real implementation:**
- Files: `node:fs`.
- System tools always by absolute path: `%SystemRoot%\System32\reg.exe` (writes only), `tasklist.exe`, `taskkill.exe`, `tar.exe`, `icacls.exe`, and `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive`. Bare names would follow `PATH`, which dev shells reorder.
- Registry reads, the process list and the port owner go through PowerShell, and each query is one call. The call first sets `[Console]::OutputEncoding = [Text.UTF8Encoding]::new()` and returns `ConvertTo-Json`. Piped output from `reg.exe` and PowerShell otherwise uses the OEM code page, which mangles non-ASCII user and project paths (`C:\Users\Zoë`).
  - Processes: `Get-CimInstance Win32_Process` (`ProcessId`, `ParentProcessId`, `ExecutablePath`, `CommandLine`, `CreationDate`).
  - Port owner: `Get-NetTCPConnection -State Listen -LocalPort <port>`. Its output is not localized, unlike the state column of `netstat`.
- Downloads (`httpGet` and `download` for non-local URLs) also go through PowerShell `Invoke-WebRequest -UseBasicParsing`, with `[Net.WebRequest]::DefaultWebProxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials`. This is the same code path as `install.ps1`. It uses the Windows proxy settings (including PAC and authenticating proxies) and the Windows certificate store, which Node's `fetch` does not. A certificate error maps to exit 11 with "Your network inspects HTTPS traffic, and Windows does not trust the certificate it presented. Download the zip from the release page and run install.ps1 -PayloadPath." Local health checks (`127.0.0.1`) use Node's `fetch`.
- Zip extraction: `tar.exe`.

Tests use in-memory fakes (§13).

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
| `--allow-elevated` | Allow an elevated (admin) process. Refused by default. Accepted only when the elevated token's user is the interactive user (the owner of `explorer.exe`), and a warning is printed; see §11. |
| `--wait-pid <pid>` | Hidden. Wait up to 60 s for that process to exit before taking the lock. Used by the `update` hand-off and the uninstall relaunch (§6.6). |
| `--runtime-dir`, `--data-dir`, `--registry-root` | Hidden, for tests only. Replace `%LOCALAPPDATA%\Programs\Hayba`, `%LOCALAPPDATA%\Hayba` and `HKCU\Software\Hayba` (for example with `HKCU\Software\HaybaTest-<rand>`). The uninstall key is not written when any of them is set. Load tests use them so they never touch the maintainer's real install (§9.6). |
| `--help`, `--version` | |

**`install`**

| Flag | Default | Meaning |
|---|---|---|
| `--payload <dir>` | the payload root this core was started from (`<core dir>\..`) | Must contain `VERSION` and `plugins\index.json`. |
| `--project <path>` (repeatable) | see §6.4 | A `.uproject` file, or a folder containing exactly one. |
| `--engine <major.minor>` | all supported | Consider only projects on this engine. Any `major.minor` listed in the payload's `plugins\index.json` is accepted. |
| `--clients <list>` | `detected` | Comma list of `claude-code,claude-desktop,cursor,vscode`, or `detected`, or `none`. |
| `--only <parts>` | `runtime,projects,clients` | A subset. `--only clients` skips the editor check, so it can run from inside the editor. A run without `runtime` may run from inside `<rt>`, with `<rt>` as the payload (§6.6). |
| `--allow-downgrade` | off | Allow a payload older than the installed runtime or a project copy (§6.6). |
| `--replace-foreign` | off | With `--yes`, replace a `hayba` client entry that is not ours (§6.10). |
| `--plugin-location project\|engine` | `project` | `engine` is the Advanced option (§5.4). |
| `--satellites <list>` | `none` (satellites already present are upgraded) | `gas,metasound` or `none`. |
| `--plan` | off | Detect and print the plan (§8.7 with `result:"planned"`). Writes nothing except the `--out` file, if one is given: no log file, no lock file. |
| `--no-doctor` | off | Skip the final doctor. |

**`doctor`:** `--project <path>` (repeatable; default: the manifest's projects), `--no-boot` (skip the server boot probe), `--report <file>` (write the pasteable report).

**`uninstall`:** `--project <path>` (repeatable; remove only from these projects and keep runtime and clients), `--clients <list>` (remove only these entries), `--remove-data` (also delete memory and logs, that is all of `%LOCALAPPDATA%\Hayba`, and the project backups). With neither `--project` nor `--clients`, it is a full uninstall.

**`update`:** `--check` (report only), `--version <x.y.z>` (default: latest). It downloads and verifies the payload (§6.13) and hands off to the **new** payload's core (§6.13 step 5), passing on `--yes`, `--allow-downgrade` and `--front-door`.

**Exit codes** (the same for every command; install.ps1 and Inno map them to messages)

| Code | Meaning |
|---|---|
| 0 | Success. Warnings are possible. |
| 1 | Internal error (a bug). The message points to the log and the issue tracker. |
| 2 | Usage error: unknown flag, bad value, no payload found, or a `runtime` part requested while the core runs from inside `<rt>` (§6.6). |
| 3 | Blocked by a running process: Unreal Editor, a Hayba server we could not stop, or another setup run holding `setup.lock`. |
| 4 | Nothing to act on: no supported engine or project for `install`, or no manifest for `uninstall`. |
| 5 | Integrity failure: hash mismatch or a malformed payload. Also a refused downgrade with `--yes` (§6.6), and an explicitly requested project that is unsupported (engine or BuildId) when it is the only selected item. |
| 6 | A write failed and was rolled back: permissions, read-only files, a locked file, or a full disk. |
| 7 | Partial success. Some projects or clients failed and the rest succeeded (details in JSON). An explicitly requested project that is unsupported counts as a failed item. Also used when the final doctor has a failing check. A doctor WARN never produces 7. |
| 8 | `doctor` only: at least one check failed. |
| 9 | Refused environment: elevated process, unsupported OS or architecture, or PowerShell Constrained Language Mode (install.ps1). |
| 10 | `update --check` only: an update is available. |
| 11 | Network error: download or `latest.json` fetch failed. |
| 130 | Cancelled by the user (Ctrl+C or a declined prompt). |

**Precedence.** When several conditions apply in one run, the core returns the first in this order: 1 > 130 > 9 > 2 > 3 > 11 > 5 > 6 > 4 > 7 > 0. Codes 8 and 10 belong to one command each and never compete. A warning, including a foreign listener on port 7821, never changes the code.

### 6.3 Module split

| Module | Input | Output / effect |
|---|---|---|
| `cli.mjs` | argv, ctx | Parsed command and flags. Dispatches, renders text or JSON, maps errors to exit codes. |
| `lock.mjs` | data dir | Takes `setup.lock` by exclusive create and writes `{pid, created}` into it, where `created` is the process creation time (`Win32_Process.CreationDate`). A lock is stale, and is stolen, when no process has that pid **and** that creation time. This survives Windows reusing a pid after a crash. Exit 3 if the holder is alive. |
| `preflight.mjs` | ctx, runtime dir, target projects, `--only` | `{ elevated, arch, editors:[{pid,exe,uproject?}], ourNodes:[{pid,exe,cmdline,ppid}], port7821:{state:'free'\|'hayba'\|'foreign', version?, pid?, image?}, longPaths:boolean }`. `stopOurNodes()` kills only processes whose image path is under `<runtime>\node\`, and always excludes its own pid and its ancestor chain. |
| `payload.mjs` | payload dir | A validated `Payload` `{version, commit, node, minPlugin, protocol, engines:EngineBuild[], dir}` read from `VERSION`, `plugins\index.json`, `runtime-files.json` and `files.json`. `verifyTree(dir, list)` checks per-file SHA256 against either list. |
| `runtime.mjs` | ctx, Payload, runtime dir | Stages and swaps `node\ server\ setup\ plugins\`, `runtime-files.json` and the licence files. Deletes `VERSION` first and writes it last. Returns `{action:'installed'\|'upgraded'\|'unchanged'\|'downgraded', previousVersion, paths[]}`. Writes `HKCU\Software\Hayba`. |
| `engines.mjs` | ctx, Payload | `Engine[] = {id, root, version:{major,minor,patch,changelist}, buildId, sources[], sourceBuild, supported, reason}`. §6.7. |
| `projects.mjs` | ctx, Engine[], manifest | `Project[] = {key, uproject, name, displayName, engineAssociation, engine?, hasCode, lastOpened?, via[], hayba:{present, kind:'copy'\|'link'\|'engine'\|null, version?, managed:boolean}, vcs:{ignoresBinaries:boolean\|null, hint?}, supported, reason, default}`. §6.8. |
| `plugin-copy.mjs` | ctx, Project, Payload, options | Stages, verifies, backs up and swaps the whole plugin set as one unit. Returns `{action:'install'\|'upgrade'\|'unchanged'\|'skip', reason?, pluginDirs[], backup?, treeHash:{<plugin>:hash}}`. §6.9. |
| `server-entry.mjs` | runtime dir, data dir | The canonical `ServerEntry {command, args, env}` (§8.6). |
| `jsonfile.mjs` | path, key path, value or `undefined` | Reads (UTF-8, UTF-8 with BOM, UTF-16LE or UTF-16BE with BOM; JSONC; symlink target), edits with `jsonc-parser`, backs up, and writes atomically in the original encoding (§6.10.1). Also used to read and edit `.uproject` files. |
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
 *   read(ctx, target): { state: 'absent'|'same'|'different'|'foreign'|'unparseable', error?: string },
 *   apply(ctx, target, entry, opts:{replaceForeign:boolean}): { action: 'add'|'update'|'unchanged'|'kept', backup?: string },
 *   remove(ctx, target, opts:{onlyIfOurs:boolean, runtimeDir:string}): { action: 'removed'|'absent'|'kept', backup?: string },
 *   afterMessage(action): string|null
 * }} ClientWriter */
```

### 6.4 `install` flow

1. Parse the flags. With `--wait-pid`, wait for that process to exit. Take the lock (not for `--plan`). Refuse an elevated process (exit 9) unless `--allow-elevated`. Refuse anything other than x64 Windows 10 1809+ or 11 (exit 9). If the core runs from inside `<rt>` and `--only` includes `runtime`, exit 2: "Run the installer or `update` to change the Hayba runtime."
2. Load the payload (`payload.mjs`) and the manifest, if one exists. **Reconcile** before anything else (not for `--plan`): finish or revert every swap the manifest records as `pending` (§6.6, §6.9), then delete leftover staging folders.
3. Detect engines, projects and clients.
4. **Build the plan.**
   - **Runtime:** `install`, `upgrade`, `unchanged` (the installed `VERSION` equals the payload's and `runtimeTreeSha256` matches) or `downgrade` (§6.6).
   - **Projects, default selection:**
     1. every project in the manifest (upgrade). A manifest project whose `.uproject` is not reachable (for example on an unplugged drive) is reported, stays in the manifest with `state:"missing"`, and is retried on the next run;
     2. plus, in interactive mode or when the manifest is empty, the supported project with the newest `LastOpenTime`;
     3. plus any `--project` given.

     A project holding a Hayba copy that is **not** in the manifest is replaced only when the user explicitly selects it.
   - **Downgrade:** a project copy newer than the payload follows the same rule as the runtime (§6.6).
   - **Clients:** every detected client that is not blocked (for `--clients detected`).
5. `--plan`: print and exit 0.
6. **Interactive** (TTY and no `--yes`): show the plan as a numbered checklist. Projects show `displayName` (the name, plus the parent folder when two projects share a name), engine and "last opened" time; unsupported projects are greyed out with the reason; clients show detected, blocked or foreign. Let the user toggle items, add a project by path, or cancel. Then confirm.
7. **Preflight** (§6.5).
8. Runtime step (§6.6). A failure here stops the run (exit 5 or 6).
9. Plugin copy for each selected project (§6.9). Projects are independent; a failure marks that project failed and the run continues.
10. Client writers for each selected client (§6.10). Clients are independent in the same way.
11. The manifest is saved after every step, recording intent before each write (§6.12).
12. Doctor in quick mode (§6.11), unless `--no-doctor`.
13. **Summary:** results per item, the follow-up messages each client needs (for example "Quit Claude Desktop from the tray"), the teammate note for projects whose ignore rules leave out plugin binaries (§6.9), the log path, and the exit code (§6.2 precedence).

### 6.5 Preflight

- **Unreal Editor.** List `UnrealEditor.exe` and `UnrealEditor-Cmd.exe` with their command lines through `Get-CimInstance Win32_Process` (fallback: `tasklist`, which gives PIDs only).
  - The `projects` part is blocked by an editor that has a selected project open (its command line names that `.uproject`), because the editor holds the plugin DLL. An editor whose project can't be read from its command line blocks every project. For an Advanced (engine-location) install, any editor on that engine blocks.
  - The `runtime` part is blocked by an editor whose sidecar runs on our `node.exe` (one of our Node processes has the editor as its parent).
  - Interactive: "Unreal Editor is running (MyGame). Save your work and close it, then press Enter. Press Ctrl+C to cancel." Re-check on Enter.
  - `--yes`: exit 3.
  - The core never terminates an editor.
- **Our Node processes** (only when the `runtime` part runs). List `node.exe` processes whose `ExecutablePath` is under `<runtime>\node\` (a case-insensitive prefix match on the normalised full path). Exclude the core's own pid and its ancestor chain.
  - Tell the user which ones will stop: "Stopping 2 Hayba server processes started by your AI apps. They start again the next time those apps use Hayba."
  - Kill them with `taskkill /PID <pid> /T /F`. Anything else is never touched.
  - If one cannot be stopped: exit 3.
- **Port 7821.** `Get-NetTCPConnection` → the PID of the listener; its image path from the process list; and `GET http://127.0.0.1:7821/api/health` with a 1 s timeout.
  - A Hayba answer is fine, and is reported with its version (after G5).
  - A foreign listener produces a **warning**, not a failure, and never changes the exit code: "Port 7821 is used by `<image>` (PID n). Hayba will install, but the in-editor chat can't start until that port is free or you change Sidecar URL in Hayba settings."
- **Disk.** At least 400 MB free on the runtime volume, and 60 MB on each target project's volume. Otherwise exit 6 before any write, with the number of MB to free.
- **Long paths.** Read `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled`. When it is not 1, a project whose path plus `\Saved\HaybaSetup\s-<ver>\` plus the longest plugin-relative path in `files.json` exceeds 259 characters is marked failed (§6.2): "`<project>`'s folder path is too long for Windows to hold Hayba's files. Move the project to a shorter path, or turn on Windows long paths." UE itself fails on such paths too.
- **OneDrive.** A project under `%OneDrive%` or `%OneDriveCommercial%` gets a warning: "`<project>` is in OneDrive. Sync can lock files while Hayba updates them; pause syncing if the install fails." Hashing skips files that have the `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` attribute, so an existing copy made of cloud-only (Files On-Demand) files is treated as changed and replaced instead of downloaded. Renames use the retry logic from §6.10.1 step 7.

### 6.6 Runtime step

1. **Reconcile** (at the start of `install` and `uninstall`, §6.4 step 2; `doctor` only reports a pending swap, as a `runtime.present` FAIL). For each runtime swap the manifest records as `pending`:
   - if `VERSION` names the new version, the swap finished: mark it `done`;
   - otherwise revert it: for each recorded rename in reverse order, restore `<rt>\<name>` from `<rt>\.old-<id>\<name>` when the target is missing or incomplete, and put back the old `VERSION` from `.old-<id>`.

   Only after that, delete leftover `.staging-*` and `.old-*` siblings. Nothing is deleted while a pending swap still needs it.
2. **Compare versions** (semver).
   - Equal, and `runtimeTreeSha256` matches the installed tree: `unchanged`. Stop here.
   - Payload older than the installed runtime: a **downgrade**. Interactive: "Downgrade Hayba from X to Y?" With `--yes`: exit 5 ("This payload is older than the installed Hayba X. Pass --allow-downgrade to go back.") unless `--allow-downgrade`.
3. Copy the payload's `node\ server\ setup\ plugins\`, `runtime-files.json` and licence files into `<rt>\.staging-<id>\` (`<id>` = `<ver>-<rand>`). Verify every file against `runtime-files.json` and each engine's `files.json`, including `node.exe` itself.
4. **Swap.** Record the swap in the manifest as `pending`, with its `<id>` and the ordered rename list. Delete `<rt>\VERSION` first (moved into `.old-<id>\`). Then, for each of `node server setup plugins`, `runtime-files.json` and the licence files:
   - rename `<rt>\<name>` to `<rt>\.old-<id>\<name>`;
   - rename the staged `<name>` to `<rt>\<name>`.

   Write `VERSION` last, then mark the swap `done`. If any rename fails, reverse the renames already made, restore the old `VERSION`, and exit 6.
5. Write `HKCU\Software\Hayba` `InstallDir` and `Version`. Update the uninstall keys as §5.3 says.
6. Delete `.old-*`. If a file is locked, leave it; the next run cleans up.

**The core never replaces the runtime while it runs from `<rt>\node\node.exe`.**
- `install` with the `runtime` part runs from a payload in `%TEMP%` or Inno's `{tmp}`. From inside `<rt>` it accepts only `--only projects` and/or `clients`, with `<rt>` as the payload, and never stops our Node processes.
- `update` hands off to the downloaded payload's core and exits (§6.13).
- `uninstall` with `--front-door inno` runs synchronously from `{app}` and leaves `node\` for Inno to delete (§7.2).
- `uninstall` from inside `<rt>` otherwise (ps1 or manual) copies `node.exe` and `setup\` into `%TEMP%\hb-<6>\`, starts that copy **detached** with `--wait-pid <own pid>`, and exits. The copy waits for the parent to exit, then runs.
- A core can't delete the folder it runs from. Each `%TEMP%\hb-<6>\` folder holds an `owner.json` with the pid and creation time of the process that uses it. Every setup run deletes `hb-*` folders whose owner has exited. After a full uninstall, one such folder can remain until the next run or until Windows cleans `%TEMP%`; the download page says so.

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

The starting point is the read-only `detect-probe.mjs` that was run on the build host. It lives outside the repo (in the gitignored `.superpowers/installer/` folder of the `hayba-brain-client` worktree), so the first setup-core task copies it into `installer/setup/lib/engines.mjs` and adapts it to the `ctx` seam. Its `execFileSync('reg', …, {encoding:'utf8'})` calls are replaced by the UTF-8 PowerShell query in §6.1.

### 6.8 Project detection

**Candidates:**

1. **Recent projects.** Each engine's `EditorSettings.ini`, lines `RecentlyOpenedProjectFiles=(ProjectName="<path>",LastOpenTime=YYYY.MM.DD-hh.mm.ss)` *(format checked on build host)*. The ini lives at:
   - Launcher engines: `%LOCALAPPDATA%\UnrealEngine\<id>\Saved\Config\WindowsEditor\EditorSettings.ini`;
   - source-built or custom engines: `<root>\Engine\Saved\Config\WindowsEditor\EditorSettings.ini`.
2. **Created-project folders.** `CreatedProjectPaths=<dir>` lines from the same files. Scan one level deep for `*.uproject`, as `FDesktopPlatformBase::EnumerateProjectsKnownByEngine` does.
3. **`<Documents>\Unreal Projects`,** one level deep. Documents is the **known folder**, not `%USERPROFILE%\Documents`: read `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders` `Personal` (REG_EXPAND_SZ; expand the variables). This follows a OneDrive redirect. Fallback: `[Environment]::GetFolderPath('MyDocuments')` through PowerShell.
4. **Picker.** Interactive mode prompts for a path. Inno shows a browse dialog. `--project` provides paths directly.

**Identity.** The same project often arrives from several sources (RecentlyOpened uses forward slashes). Each candidate's `key` is `fs.realpathSync.native(<uproject>)`, lower-cased, with backslashes. Candidates with the same key merge into one project, and their `via[]` lists are joined. The manifest stores this key, and every manifest lookup uses it. `displayName` is the project name, plus the parent folder (`MyGame (D:\Games)`) when two projects share a name. Inno always shows the parent folder as the hint.

**Reading `.uproject` files** goes through `jsonfile.mjs`. UE saves them with `FFileHelper::SaveStringToFile`'s default `AutoDetect` encoding (`ProjectDescriptor.cpp:257`, `FileHelper.cpp:787` in the 5.8 sources), so a file with any non-ANSI text, such as a Japanese description, is UTF-16LE with a BOM. `EditorSettings.ini` is UTF-8 without a BOM, which the plain reader handles.

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
- `managed` = the project's key is in the manifest.
- `vcs.ignoresBinaries`: whether source control would leave out `Plugins/HaybaMCPToolkit/Binaries/`. UE's standard `.gitignore` ignores every `Binaries/` and `Intermediate/` folder, so a committed plugin reaches teammates as source without DLLs, and a Blueprint-only project then asks to rebuild modules, which fails without Visual Studio.
  - If `git.exe` is on `PATH` and the project is in a work tree: `git -C <project> check-ignore -q Plugins/HaybaMCPToolkit/Binaries/Win64/UnrealEditor.modules` (read-only).
  - Otherwise, a `.gitignore` or `.p4ignore` in the project folder with a line matching `Binaries` sets it to `true` ("probably").
  - No ignore file and no work tree: `null`.

### 6.9 Plugin copy

For each selected project, with engine E:

1. **Refuse** (result `skip`, and the run continues) when:
   - `Plugins\HaybaMCPToolkit`, or `Plugins` itself, is a link, or its real path lies inside a Hayba source checkout (a folder containing `mcp-tools\hayba-mcp`). Message: "Left `<path>` alone: it is a link to a developer checkout."
   - any existing file in the Hayba plugin directories is read-only (`(mode & 0o200) === 0`). Message: "`<Project>`: Hayba's plugin files are read-only, probably because they are checked in to source control. Check out `Plugins/HaybaMCPToolkit` and run the installer again."
2. **Choose the set.**
   - The Toolkit always.
   - Satellites that are ticked, or already present in the project (the locked set: all of them come from the same release).
   - Stale `HaybaMCPNiagara` and `HaybaMCPSequencer` directories, which ADR-0008 removed, are moved into the backup and reported. The step-1 link check applies to them too: a stale satellite that is a link (ADR-0008's evaluation installed them as junctions) is skipped and reported, never moved.
3. **Stage.** Delete any leftover `Saved\HaybaSetup\s-*` folder from an interrupted run. Copy `<rt>\plugins\E\<P>\` for every plugin in the set into `<Project>\Saved\HaybaSetup\s-<ver>\<P>\`. Verify every file against `files.json`.
4. **Check the BuildId.** The staged `Binaries\Win64\UnrealEditor.modules` `BuildId` must equal the engine's. If not, the project is `skip` (not selected explicitly) or failed (selected explicitly; §6.2 gives the exit code).
5. **Unchanged?** If every existing plugin's tree hash equals the staged one, the result is `unchanged`. Delete the staging.
6. **Swap the whole set as one unit.** Record the swap in the manifest as `pending`, with the ordered rename list. For each plugin in the set:
   - rename `Plugins\<P>` to `Saved\HaybaSetup\backup\<UTC>\<P>`;
   - rename `s-<ver>\<P>` to `Plugins\<P>`.

   A plugin with no existing copy skips the first rename. When every rename succeeds, mark the swap `done`. If any rename fails, reverse every rename already made, across all plugins, so the Toolkit and the satellites always come from one release. Reconcile (§6.4 step 2) reverts a pending project swap from the backup when the process died in the middle. If `Saved` is on another volume (a junction), fall back to copy and delete, and note in the log that this path is not atomic.
7. Prune older backups, keeping 2. Record in the manifest: `pluginDirs`, `backup`, `treeHash` (per plugin), `version`, `engine`, `buildId`.
8. **Advanced engine location:** the same steps against `<Engine>\Engine\Plugins\Marketplace\`, followed by the `.uproject` enable edit through `jsonfile.mjs` (backed up, `uprojectEdited:true`). If `Marketplace\` is not writable: "Can't write to `<path>`. Use the default project install instead."
   - Launcher engines grant `BUILTIN\Users:(OI)(CI)(F)` there *(checked on build host, UE 5.8)*. Any local user could then replace the Hayba DLL that loads in everyone's editor. The Advanced option says so in its description.
   - After the swap, the core sets an explicit ACL on the installed plugin folders with `%SystemRoot%\System32\icacls.exe`: inheritance off; the owner, SYSTEM and Administrators full control; Users read and execute. A real-Windows test checks the result (§13).

**Version control.** The core never runs a VCS write. After the swap, the summary notes that `Plugins/HaybaMCPToolkit` changed. When `vcs.ignoresBinaries` is `true` or "probably", the summary and doctor also say:

> Your source control ignores `Binaries/`, so teammates will get Hayba's source but not its DLLs. Either each teammate runs the Hayba installer for this project, or add these lines to `.gitignore`:
> `!Plugins/HaybaMCPToolkit/Binaries/`
> `!Plugins/HaybaMCPToolkit/Intermediate/`
> (and the same for each satellite you use).

The download page carries the teammate recipe: run the one-liner with `-Project <path>`; or, when the plugin arrives through source control with its binaries, run it with `-Only runtime,clients`.

### 6.10 Client writers

All four receive the same `ServerEntry` (exact JSON in §8.6):

- `command` = `<rt>\node\node.exe`
- `args` = `[<rt>\server\dist\bootstrap.js]`
- `env`:
  - `HAYBA_MEMORY_DB` = `%LOCALAPPDATA%\Hayba\memory\hayba-memory.db`;
  - `HAYBA_CODE_MODE` = `on` (config.ts:74 treats anything but `off` as on; the value is explicit so the intent is visible to anyone reading the config).

Paths are absolute and expanded; JSON config files do not expand `%VAR%`. The server name is always `hayba`.

**Foreign entries.** An existing `hayba` entry whose `command` is outside `<rt>` and which is not in the manifest is `foreign`: typically a developer's own entry pointing at a repo build. Uninstall already keeps such entries (§6.12), and install treats them the same way:
- Interactive: "Your `<client>` config already has a 'hayba' entry that runs `<command>`. Replace it with the installed Hayba?" (default No).
- `--yes`: keep it, and report `kept` with the same text, unless `--replace-foreign` is given.
- A replaced foreign entry is always backed up first (§6.10.1 step 5, §6.10.2 Apply).

#### 6.10.1 File-writer algorithm (Claude Desktop, Cursor, VS Code)

1. **Resolve the target path.** If it is a symlink, resolve it with `realpath` and write to the target, so a dotfiles link is not replaced by a regular file. If the file is missing, use `{}` and create the parent folder.
2. **Read the bytes.** Detect the encoding from the BOM (UTF-8, UTF-16LE, UTF-16BE; no BOM means UTF-8), and remember it, the line endings (CRLF or LF) and the indent (tabs, 2 or 4 spaces).
3. **Parse with `jsonc-parser`** (comments and trailing commas allowed).
   - On a parse error, or a root that is not an object, **refuse**: "`<file>` is not valid JSON (line L, column C). Hayba left it untouched. Fix or move the file and run the installer again." That client's result is `failed`; the other clients continue.
4. **Compare.** If `<key>.hayba` deep-equals the desired entry, the result is `unchanged`: no backup and no write. A foreign entry follows the rule above.
5. **Back up** the original bytes to `%LOCALAPPDATA%\Hayba\backups\<UTC>\<client-id>\<basename>`, if the file existed. Prune that client's backups to the newest 3.
6. **Edit.** `modify(text, [key, 'hayba'], entry, {formattingOptions})` → `applyEdits`, which preserves comments, key order, unknown keys and the formatting style. Re-parse the result and assert that nothing outside `<key>.hayba` changed. If anything did, abort with exit 1 (a bug).
7. **Write atomically.**
   - write `<path>.hayba-tmp-<rand>` in the same folder, in the original encoding and with the BOM if the original had one, and fsync it;
   - rename it over the target (on Windows, `fs.renameSync` replaces an existing file);
   - on EPERM or EBUSY (the app or antivirus holds the file), retry 5 times with backoff from 100 to 1600 ms, then report `failed` with "Windows is holding `<file>` open. Close `<app>` and run the installer again."
8. **Remove** uses the same path with `value = undefined`. If `<key>` becomes empty, it is left as `{}`.

The writers read and touch only `<key>.hayba`. The values of other entries are never logged, printed or copied anywhere except the byte-for-byte backup, because they may hold other tools' API keys (§11).

#### 6.10.2 Claude Code (CLI)

- **Blocked** when `C:\Program Files\ClaudeCode\managed-mcp.json` exists: the organisation manages MCP servers. The result is `manual`, with the message "Your organisation manages Claude Code's MCP servers. Ask your administrator to add this entry:" followed by the JSON. If `managed-settings.json` exists in the same folder with `allowedMcpServers` or `deniedMcpServers`, add a warning that the entry may be filtered.
- **Executable:**
  1. the first `claude.exe` on `PATH` (`.exe` only);
  2. otherwise `%USERPROFILE%\.local\bin\claude.exe` (the native installer's location; *checked on build host*).

  A candidate counts only if `claude.exe --version` (execFile, 10 s timeout) prints a line containing "Claude Code". Claude Desktop's executable is also named `claude.exe`, so the file name alone is ambiguous.

  If only a `.cmd` or `.ps1` shim exists (an npm install), the result is `manual` and the core prints the exact command to paste. The core never runs a shell to call a shim, because quoting JSON through `cmd.exe` is not reliable. **This narrows the approved design** ("`claude` on PATH") on purpose: npm-installed Claude Code gets the manual path.
- **Read.** Parse `%USERPROFILE%\.claude.json` (read-only, BOM-safe). Compare `mcpServers.hayba` (user scope) with the desired entry.
  - Also list any project-scope `projects[<dir>].mcpServers.hayba` entries and report them as warnings: "A project-level 'hayba' entry in `<dir>` overrides this one." The core does not touch them.
- **Apply.**
  - If absent: `claude.exe mcp add-json hayba <json> --scope user`, run through `execFile` with an argv array (no shell) and a 30 s timeout.
  - If different (ours, or foreign with consent): snapshot the existing entry from `.claude.json` into `backups\<UTC>\claude-code\hayba.json`, run `claude.exe mcp remove hayba --scope user`, then add. If the add fails, re-add the snapshot with `mcp add-json` and report `failed`, so the old entry is never lost.

  Re-read `.claude.json` to confirm. *(Checked on build host: Claude Code 2.1.283 has `mcp add-json <name> <json> -s user` and `mcp remove <name> -s user`.)*
- **Remove:** `claude.exe mcp remove hayba --scope user`.
- **After:** "Restart any open Claude Code sessions to load Hayba."

#### 6.10.3 Claude Desktop (file, key `mcpServers`)

- **Detect:** `%APPDATA%\Claude\` exists, or a `%LOCALAPPDATA%\Packages\Claude_*` folder exists (MSIX).
- **Target:**
  - if any `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json` **exists**, use the one with the newest modification time (the MSIX shadow copy wins, because the packaged app reads it first);
  - otherwise `%APPDATA%\Claude\claude_desktop_config.json`.

  *(Checked on build host: an MSIX package folder exists, with no shadow config; the `%APPDATA%` file exists.)*
- **Running app.** Claude Desktop is running when a `claude.exe` process has its image under `%LOCALAPPDATA%\AnthropicClaude\` or under a `WindowsApps\Claude_*` package folder. The path, not the image name, tells it apart from Claude Code. The running app may rewrite its config from memory and drop our entry *(unverified; OV-17)*.
  - Interactive: "Claude Desktop is running. Quit it from the system tray (closing the window is not enough), then press Enter." Re-check on Enter.
  - `--yes`: write anyway. The after-message asks for the restart, and the final doctor re-reads the file.
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
| `runtime.present` | `node.exe`, `server\dist\bootstrap.js`, `VERSION` exist; `VERSION.version` equals the manifest; the installed tree matches `runtime-files.json` | all true | FAIL: "Hayba's runtime is missing or incomplete. Run the installer again." |
| `runtime.exec` | Start `node.exe --version` | it runs | FAIL when Windows refuses to start it (Win32 error 1260, "blocked by group policy"): "Your organisation blocks programs in AppData, so Hayba's Node can't run. Ask IT to allow `<path>`, or build Hayba from source." |
| `runtime.node` | `node.exe -p process.versions.node` | ≥ 22.13.0 (the bundled one is 24.x) | FAIL, with the same fix as `runtime.present` |
| `runtime.boot` | Spawn `node.exe bootstrap.js` with `cwd` = a new temp folder, `HAYBA_PROJECT_DIR` and `HAYBA_DATA_DIR` = temp folders, a temporary `HAYBA_MEMORY_DB`, `UE_TCP_PORT` = a closed port (so it never reaches a live editor on 52342), and free ephemeral `DASHBOARD_PORT` and `HAYBA_MCP_HTTP_PORT`. Send MCP `initialize` over stdio; expect a result within 20 s. Then `GET /api/health` on the dashboard port. Kill the process tree and delete the temp folders. | initialize OK, `status:"ok"`, and the version equals `VERSION` (after G5) | FAIL: "The Hayba server did not start" plus the last 20 stderr lines, redacted |
| `data.writable` | Create and delete a temporary file under `%LOCALAPPDATA%\Hayba` | ok | FAIL: "Can't write to `<dir>`" |
| `project.<n>.plugin` | The plugin directory exists; its kind; `VersionName` against the runtime's `VERSION` (`version` and `minPlugin`, G5); plugin `BuildId` against the engine `BuildId` | real copy, same version, same BuildId | WARN for a link ("developer link, not managed"), or for an older copy that still satisfies `minPlugin` ("re-run the installer for this project to update it"). **FAIL** for a copy below `minPlugin` ("this project's Hayba plugin is too old for the installed runtime; re-run the installer for this project"), and for a BuildId mismatch ("this copy was built for a different engine build; re-run the installer"). The fix text gives the exact `install --only projects --project <p>` command, which repairs the copy from `<rt>\plugins` (§5.1). |
| `project.<n>.vcs` | `vcs.ignoresBinaries` (§6.8) | `false` or `null` | WARN with the teammate text from §6.9 |
| `project.<n>.engine` | The engine is still present and supported | yes | FAIL, with the §6.7 reason text. A manifest project on a missing drive is WARN ("not reachable; kept in the record"). |
| `port.7821` | Same as preflight | free, or Hayba with the same version | WARN for a foreign process or another version |
| `client.<id>` | The entry exists, parses, and points at existing files | yes | WARN if absent although the manifest has it; WARN if blocked, manual or foreign-kept |

**Report** (`--report` or text mode), made to paste into an issue:

- The header gives the Hayba version, the Windows build and architecture, and the Node version.
- One line per check.
- Redaction, applied to the whole report (SC7):
  - `%USERPROFILE%` replaces the user's folder;
  - the bare Windows user name is replaced by `<user>` wherever it appears as a whole path segment or word, for example in `D:\Zoe\...`;
  - a OneDrive folder suffix (`OneDrive - Contoso`) becomes `OneDrive - <org>`;
  - projects appear as `<project:Name>` plus the drive letter, never as full paths.
- It never prints provider keys, environment values other than the two Hayba keys, or any client entry other than `hayba`.

Quick mode (end of install) runs every check. `--no-boot` skips `runtime.boot`.

### 6.12 Manifest and uninstall

The manifest (§8.5) records every path, registry key, config entry and backup the core wrote. The rules:

- An entry is recorded **before** its write (`state:"pending"`) and marked `done` after it, so uninstall can clean up after a crash.
- `install` and `uninstall` reconcile pending entries at start (§6.4 step 2); `doctor` only reports them. Runtime and project swaps are finished or reverted (§6.6, §6.9). A pending client entry is re-read: if the config holds our entry, it becomes `done`; otherwise the intent is dropped.
- The manifest is written atomically (temporary file, then rename).

**`uninstall` steps:**

1. Load the manifest; exit 4 if there is none. If running inside `<rt>`: with `--front-door inno`, continue in place (§7.2); otherwise relaunch detached from `%TEMP%` and exit (§6.6). Take the lock (after `--wait-pid`, in the relaunched copy). Reconcile pending swaps (§6.6).
2. Interactive: ask "Also remove your Hayba memory and logs?" (default No). The prompt says that config backups are always removed, because they can hold other apps' keys. `--remove-data` answers yes.
3. Run preflight: editors block project removal; our Node processes are stopped (excluding the core's own pid and ancestors).
4. **Clients.** For each client in the manifest, `remove()`. A `hayba` entry that is not in the manifest is removed only when its `command` points inside `<rt>`. A developer's own `hayba` entry pointing at a repo build is kept and reported.
5. **Projects.** For each manifest plugin directory that is still a real directory (not a link) at the recorded path:
   - rename it to `<Project>\Saved\HaybaSetup\rm-<rand>\<P>` (engine installs: `<Engine>\Engine\Saved\HaybaSetup\rm-<rand>\<P>`). This is the same volume, so the rename never fails with `EXDEV`, and the folder is inside an allowed root;
   - `safeRemove` the `rm-<rand>` folder;
   - revert `.uproject` edits we made (`uprojectEdited`).

   A directory that became a link, or whose `.uplugin` no longer says `CreatedBy: "Hayba"`, is skipped and reported.
6. **Runtime.** Delete the manifest-listed children of `<rt>`, then `<rt>` itself if it is empty. With `--front-door inno`, `node\` is left for Inno, and Inno's own files belong to Inno.
7. **Registry.** Delete `HKCU\Software\Hayba`, and the ps1 uninstall key if we own it.
8. **Data.**
   - Always: delete `backups\`, `install-manifest.json` and `setup.lock`.
   - With a yes in step 2: also delete the rest of `%LOCALAPPDATA%\Hayba` and each project's `Saved\HaybaSetup`.
   - Otherwise: keep `memory\`, `logs\` and the other G7 user data.

**Deletion guard.** Every recursive delete goes through one `safeRemove(path, expectation)`. It asserts that the path:

- is absolute and normalised;
- is not a link, and is not reached through a link;
- is under an allowed root (`<rt>`, `%LOCALAPPDATA%\Hayba`, a manifest project's `Plugins\` or `Saved\HaybaSetup\`, the engine's `Plugins\Marketplace\` or `Saved\HaybaSetup\` for engine installs, or a `%TEMP%\hb-*` folder the core created);
- has the expected basename (`HaybaMCPToolkit`, `node`, `rm-<rand>`, and so on).

Any mismatch is a bug (exit 1). Nothing is deleted in that case.

**Partial uninstall.** `--project` removes only those projects' copies. `--clients` removes only those entries. The runtime and data are kept in both cases.

### 6.13 Update

All downloads go through the PowerShell path in §6.1 (system proxy, Windows certificate store).

1. `GET https://hayba.vercel.app/latest.json`, or `https://hayba.vercel.app/releases/v<ver>.json` with `--version` (Q7). HTTPS only. Timeout 15 s; failure is exit 11.
2. Compare versions (semver). `--check` prints current and latest, then exits 0 (up to date) or 10 (update available). An older `--version` is a downgrade (§6.6). `latest.json` must list the user's engines. If an installed project's engine is missing from it, say so and continue only for the other projects.
3. Download `SHA256SUMS` and the payload from `https://github.com/zajalist/hayba/releases/download/v<ver>/`, into `%TEMP%\hb-<6>\`.
   - Redirects: GitHub answers with a 302 to `release-assets.githubusercontent.com` *(checked with `curl -sI` on a release asset, 2026-09-28)*; older releases used `objects.githubusercontent.com`. The final host must be one of `github.com`, `release-assets.githubusercontent.com` and `objects.githubusercontent.com`, or the file is deleted and the result is exit 11.
   - Integrity does not rest on the host list. The payload's size must equal `latest.json`'s `size`; on a mismatch retry once, then exit 11 with "The download was incomplete." Its SHA256 must equal **both** `latest.json` (website) and `SHA256SUMS` (GitHub); any disagreement is exit 5, and the files are deleted.
4. Extract with `%SystemRoot%\System32\tar.exe -xf` (bsdtar; it refuses `..` paths). Afterwards, assert that every extracted path is inside the destination folder.
5. **Hand off.** `update` itself runs from `<rt>\node\node.exe`, which the new core must replace, so it must not be alive during the swap.
   - Release `setup.lock`.
   - Start `<new>\node\node.exe <new>\setup\hayba-setup.mjs install --payload <new> --wait-pid <own pid> --out <new>\..\result.json [--yes] [--allow-downgrade] [--front-door ...]` **detached**, in its own visible console window, so its prompts and summary stay readable. Without `--yes`, it waits for Enter before the window closes. The `%TEMP%\hb-*` folder it runs from is deleted by a later setup run (§6.6).
   - Print "Hayba `<ver>` is installing in a new window. The result will be in `<file>`." and exit 0.
   - The new core waits for the old pid to exit, takes the lock, and runs the normal install, including preflight. Its own pid and ancestors are never stopped (§6.5).

`update` runs only when the user asks, and it never runs in the background. That keeps it inside Q6. The self-updater remains a later, opt-in feature.

---

## 7. Front doors and in-editor surface

### 7.1 `install.ps1` contract (front door B)

**Where it lives:**
- `https://hayba.vercel.app/install.ps1`, the static file `website/install.ps1`, deployed with the website's clean-worktree recipe. `vercel.json` has no build step and git auto-deploy is off.
- A copy is attached to each release.

The builder generates it from `installer/ps/install.ps1.tmpl` with `{{VERSION}}`, `{{PAYLOAD_NAME}}`, `{{PAYLOAD_SHA256}}`, `{{PAYLOAD_SIZE}}` and `{{REPO}}` filled in. The hash is embedded, so an attacker who controls only the GitHub release can't get a tampered payload run through the one-liner. The script itself comes from the website and runs as it is, so whoever controls the website controls what the one-liner does. That is true of every `irm | iex` installer, and §11 states it as the threat model.

**Usage**
```powershell
irm https://hayba.vercel.app/install.ps1 | iex
# with options:
& ([scriptblock]::Create((irm https://hayba.vercel.app/install.ps1))) -Project 'D:\Games\MyGame\MyGame.uproject' -Clients claude-code,cursor
```

**Parameters:**
- `-Version <x.y.z>`: instead of the embedded version, fetch `https://hayba.vercel.app/releases/v<ver>.json` (website) and that release's `SHA256SUMS` (GitHub). Both must give the same payload hash and size, or the result is code 5. When the requested version is older than the installed runtime, the script asks "Install the older Hayba `<ver>`?" and passes `--allow-downgrade` only after a yes.
- `-Project <string[]>`, `-Engine <string>`, `-Clients <string>`, `-NoClients`, `-Only <string>` (maps to `--only`; the teammate recipe uses `-Only runtime,clients`, §6.9), `-Yes`.
- `-AllowElevated`: maps to `--allow-elevated` (see step 3).
- `-Doctor` and `-Uninstall`: run the installed core's `doctor` or `uninstall`. If there is no runtime: "Hayba isn't installed for this user."
- `-PayloadPath <zip>` together with `-Sha256 <hex>`: for testing, and for networks that block the download (the manual route in §12).
- `-KeepDownload`.

**Behaviour, in order:**

1. The whole script body runs inside `& { ... }`, so no variables leak into the user's session. `$ErrorActionPreference='Stop'` and `$ProgressPreference='SilentlyContinue'` are set in that scope (the progress bar makes downloads very slow in Windows PowerShell 5.1).
2. It **never calls `exit`**: under `iex`, `exit` closes the user's PowerShell window. It sets `$global:LASTEXITCODE` and returns.
3. It refuses (code 9, with a message):
   - `$ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage'`: "PowerShell is in Constrained Language mode (set by your organisation). Download the installer from https://hayba.vercel.app/download instead."
   - A 32-bit or ARM operating system: `-not [Environment]::Is64BitOperatingSystem`, or an architecture other than `AMD64` in `$env:PROCESSOR_ARCHITEW6432` (set when 32-bit PowerShell runs on 64-bit Windows) or else `$env:PROCESSOR_ARCHITECTURE`. A 32-bit PowerShell on x64 Windows is accepted.
   - An elevated session, unless `-AllowElevated`: "Run this from a normal PowerShell window, not as administrator. Hayba installs for your user only and never needs admin rights. If this is your only account (UAC off, or the built-in Administrator), add -AllowElevated." With `-AllowElevated`, the script continues only when the elevated user is the interactive user (the owner of `explorer.exe`), and prints a warning.
4. It enables TLS 1.2: `[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072`. It sets `[Net.WebRequest]::DefaultWebProxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials`, so an authenticating corporate proxy works in Windows PowerShell 5.1.
5. It checks free space on the `%TEMP%` volume: at least 250 MB, or 650 MB when `%TEMP%` and `%LOCALAPPDATA%` share a volume (the download, the extracted payload and the runtime). Otherwise code 6: "Free at least `<n>` MB on `<drive>` and run this again."
6. It creates `%TEMP%\hb-<6 random>\` (a short name, for the long-path budget) and downloads `https://github.com/{{REPO}}/releases/download/v{{VERSION}}/{{PAYLOAD_NAME}}` with `Invoke-WebRequest -UseBasicParsing`. A network failure is code 11. A certificate error is code 11 with the "your network inspects HTTPS" message from §6.1.
7. It checks the file size against `{{PAYLOAD_SIZE}}`. On a mismatch it downloads once more, then returns code 11: "The download was incomplete. Check your connection and try again." Only a file of the right size gets a hash check.
8. It checks `(Get-FileHash -Algorithm SHA256).Hash` against the embedded hash, ignoring case. On a mismatch it deletes the folder and returns code 5: "The download does not match the published checksum. Nothing was installed. Try again later, or report it."
9. It extracts with `& "$env:SystemRoot\System32\tar.exe" -xf` (fallback: `Expand-Archive`). R8 keeps every payload path short enough for `Expand-Archive` without long-path support.
10. It checks `Get-AuthenticodeSignature node\node.exe`: `Status -eq 'Valid'` and the signer subject starts with `CN=OpenJS Foundation` *(checked on build host for 24.14.0; OV-9 for the pinned build)*. Otherwise code 5.
11. It runs `& $node $core install --payload $root --front-door ps1 [mapped flags]` in the same console, so the core can prompt, and passes `$LASTEXITCODE` through. If Windows refuses to start `node.exe` (Win32 error 1260, "This program is blocked by group policy", from AppLocker or WDAC), it returns code 9: "Your organisation blocks programs in AppData, so Hayba can't run here. Ask IT to allow it, or build Hayba from source: https://hayba.vercel.app/docs/#build-from-source."
12. It deletes the temporary folder unless `-KeepDownload` was given. It prints the core's summary, which already includes the doctor result and the next steps.

The script contains about 170 lines of logic. It does not change the execution policy, write to the registry, or install anything itself.

### 7.2 `HaybaSetup.exe` contract (front door A, Inno Setup 6)

**Script settings:**
- `PrivilegesRequired=lowest`, with no override option;
- `ArchitecturesAllowed=x64compatible`;
- `DefaultDirName={localappdata}\Programs\Hayba`, `UsePreviousAppDir=no`;
- `DisableWelcomePage=yes`, `DisableDirPage=yes`, `DisableProgramGroupPage=yes`, `DisableReadyPage=yes`;
- `Compression=lzma2/ultra64`, `SolidCompression=yes`;
- a fixed `AppId` GUID, generated once in Phase 4 and never changed afterwards (it ties upgrades and the uninstall entry together);
- `SignTool=` and `SignedUninstaller=yes` with an RFC 3161 timestamp (`/tr <tsa> /td sha256 /fd sha256`). `<tsa>` is the timestamp URL of the signing provider chosen in Phase 4 (OV-5);
- `CloseApplications=no`, because the core handles running processes.

**Payload.** Embedded as `[Files]` with `Flags: dontcopy`. The installer never extracts it straight into `{app}`. The core installs the runtime so that the swap and the manifest are the same as on the one-liner path.
- For the plan, only `node\node.exe`, `setup\**`, `VERSION` and `plugins\index.json` are extracted to `{tmp}\payload\`, so the page appears quickly and antivirus scans only a few files.
- The rest is extracted at `ssInstall`, before the install command runs.

**The one page (a custom wizard page, shown first):**
1. While the page shows "Looking for Unreal Engine projects…", the installer runs `{tmp}\payload\node\node.exe {tmp}\payload\setup\hayba-setup.mjs install --plan --json --out {tmp}\plan.json --payload {tmp}\payload --front-door inno`, with the window hidden and waiting for it to finish. `--plan` needs only the files above.
2. It shows two checklists built from `plan.json`: **Projects** (`displayName`, "UE 5.8", last opened, with the parent folder always shown as the hint; `default:true` items pre-ticked; unsupported items disabled, with the reason as a hint) and **AI apps** (detected items pre-ticked; blocked, manual or foreign items shown with a note).
3. A **Customize** link reveals: "Add a project…" (a file browse dialog for `.uproject` files), "Install into the engine instead (Advanced)", and "Also install GAS / MetaSound command sets".
4. The Next button reads **Install**.

**Install.** In `CurStepChanged(ssInstall)` the installer runs `... install --yes --json --out {tmp}\result.json --progress {tmp}\progress.jsonl --payload {tmp}\payload --front-door inno` with explicit `--project`, `--clients`, `--plugin-location` and `--satellites` values. A timer reads `progress.jsonl` to drive the progress bar.

**Finish page.** It renders `result.json`: per-item results, each client's follow-up text, the doctor summary, and a "Copy diagnostic report" button, which runs `doctor --report {tmp}\report.txt` and copies the text. An exit code other than 0 or 7 shows the mapped message from §12, and still offers the report.

**Uninstall (Apps & features → Hayba):**
- `InitializeUninstall` asks: "Also remove my Hayba memory and logs? (Saved copies of your AI apps' settings are always removed.)"
- `[UninstallRun]` runs `"{app}\node\node.exe" "{app}\setup\hayba-setup.mjs" uninstall --yes --front-door inno [--remove-data]` and waits for it. With `--front-door inno` the core does **not** relaunch itself: it runs synchronously, removes everything it owns except `{app}\node\` (which its own process is using), and returns.
- `[UninstallDelete] Type: filesandordirs; Name: "{app}\node"` then removes `node\`, after the core has exited.
- Inno then removes `unins000.*` and `{app}` if it is empty.

This order avoids both failure modes: Inno deleting `{app}` while a relaunched core is still working, and a waiting core keeping `node.exe` locked.

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
- **Request:** FHttpModule `GET https://hayba.vercel.app/latest.json` (Q7) with a 5 s timeout. The request carries no identifiers beyond a normal HTTPS request.
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

**When it ships.** Default: Phase 5 (§14), together with "Connect AI client". Testers on the first betas then learn about updates through the tester channel, because a release without the notice can never announce the release after it. The notice is small, so the maintainer may pull it into Phase 1; the plan for Phase 1 lists it as an optional task.

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
  "minPlugin": "0.4.0",
  "protocol": 1,
  "engines": [
    { "engine": "5.7", "buildId": "47537391" },
    { "engine": "5.8", "buildId": "55116800" }
  ],
  "runtimeTreeSha256": "…64 hex…"
}
```

- The plugin reads `node` from this file (G1), so it can trust the bundled Node without spawning it.
- `minPlugin` is the oldest plugin `VersionName` this runtime works with, and `protocol` is the plugin-to-server protocol number (G5).
- `runtimeTreeSha256` is computed from `runtime-files.json` the same way as `treeSha256` in §8.2.
- The version numbers are examples. The first installer release is `0.4.0` (Q8).

**`EngineBuild`** is `{engine, buildId}`, with `engine` as `major.minor`. `VERSION`, `plugins/index.json` (which adds `plugins`) and `latest.json` all use `EngineBuild[]`.

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

**`runtime-files.json`** (payload root and runtime root) has the same shape for everything outside `plugins\`: `{"schema":1, "files": {"node/node.exe": "…", "server/dist/bootstrap.js": "…", "setup/hayba-setup.mjs": "…", "LICENSE": "…", …}}`. It does not list `VERSION` or itself. The core verifies every staged file against it, `node.exe` included, so a payload is checked by the core as well as by `install.ps1`.

### 8.3 `latest.json` (release asset, and on the website)

The consumers read it from the website: `https://hayba.vercel.app/latest.json` for the newest release, and `https://hayba.vercel.app/releases/v<ver>.json` for a given one (Q7). R10 publishes both copies. The GitHub release carries the same file, and `…/releases/latest/download/latest.json` also resolves, because betas are normal releases.

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
  "minPlugin": "0.4.0",
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
- `update` checks the payload hash against both the website's `latest.json` and GitHub's `SHA256SUMS`.
- `install.ps1 -Version` checks its payload line against the website's `releases/v<ver>.json`.
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
    "state": "done",
    "swap": null
  },
  "data": { "dir": "C:\\Users\\Ada\\AppData\\Local\\Hayba", "created": true },
  "projects": [
    {
      "key": "d:\\games\\mygame\\mygame.uproject",
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
      "state": "done",
      "swap": null
    }
  ],
  "clients": [
    { "id": "claude-code",    "method": "cli",  "exe": "C:\\Users\\Ada\\.local\\bin\\claude.exe", "scope": "user", "name": "hayba", "state": "done" },
    { "id": "claude-desktop", "method": "file", "path": "C:\\Users\\Ada\\AppData\\Roaming\\Claude\\claude_desktop_config.json", "key": "mcpServers", "name": "hayba",
      "entrySha256": "…", "backup": "C:\\Users\\Ada\\AppData\\Local\\Hayba\\backups\\20261020T120500Z\\claude-desktop\\claude_desktop_config.json", "state": "done" }
  ]
}
```

- `state` is `pending` (recorded before the write), `done`, or, for projects only, `missing` (the `.uproject` is not reachable, for example on an unplugged drive; kept and retried).
- `key` is the normalised project key (§6.8). All lookups use it.
- `swap` is `null`, or, while a swap runs, `{id, target:<version>, state:"pending", renames:[[from, to], …]}` with the renames in execution order. Reconcile uses it to finish or revert the swap (§6.6, §6.9).
- `treeHash` is a map keyed by plugin name, as in `plugin-copy.mjs`'s result.
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

No entry sets `DASHBOARD_PORT`, `UE_TCP_PORT` or any key. `UE_TCP_PORT` stays unset so the server discovers the editor: `resolveTargetPort` uses `UE_TCP_PORT` when set, otherwise the heartbeat walk up from the working directory, otherwise 52342 (tcp-client.ts:222-227).

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
  "handoff": null,
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

With `--plan`, `result` is `"planned"` everywhere and `doctor` is `null`. `handoff` is set only by `update` and the uninstall relaunch: `{pid, resultFile}` of the detached core.

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
     [--fixtures <dir>]                  # default D:\HaybaRelease\fixtures (§9.6)
     [--compile-only --engines 5.7]      # the 5.7 compile gate (§10.1), about 3 min
     [--make-fixtures --engines 5.7,5.8] # create the load-test fixture zips once per engine
```

`--skip-load-tests` is allowed only without `--publish-draft`.

### 9.3 Steps

| Step | What | Fails the release when |
|---|---|---|
| R0 Preconditions | The commit is reachable from `origin/main`. `--require-ancestor` holds (set to the P0 merge commit once P0 lands). Each engine exists and its BuildId matches the table. The tools are present. | any check fails |
| R1 Source | `git archive <commit>` → `<out>/src` (a clean tree, no local artefacts, no links) | |
| R2 Stamp | In `src` only: `.uplugin` `VersionName` = version, `Version` = MAJOR·10000 + MINOR·100 + PATCH; server `package.json` `version`. G5 already keeps the source values equal, so R2 only replaces one equal version with another. | the source `.uplugin` `VersionName` and server `package.json` `version` differ (the G5 check) |
| R3 Build (F1) | For each engine: generate `<out>/host-<E>/HaybaHost.uproject` (EngineAssociation `<E>`; a trivial `HaybaHost` game module with `Target.cs` files; the three plugins **copied** into `Plugins/`), then run `"<root>\Engine\Build\BatchFiles\Build.bat" HaybaHostEditor Win64 Development -Project=<uproject> -WaitMutex -NoHotReload`. A host project, not `RunUAT BuildPlugin`: 5.7's BuildPlugin has no `-Dependencies` flag, so the satellites cannot resolve the Toolkit, and BuildPlugin writes `Config/FilterPlugin.ini` into the source tree. | UBT fails; or the **completeness check** fails. This catches a "Succeeded" build that silently left out a new file. |
| R4 Assemble (F1) | For each engine and plugin, copy into `stage/hayba-<ver>/plugins/<E>/<P>/` using the layout in §9.5. Rewrite the `.uplugin` with `"Installed": true` and `"EngineVersion": "<E>.0"`. Move PDBs into `symbols/<E>/<P>/Binaries/Win64/`. Write `files.json`. | a module in the `.uplugin` has no DLL; `UnrealEditor.modules` BuildId ≠ the engine's ≠ the table's |
| R5 Node (F2) | Read `installer/release/node-version.json` `{version, zipSha256}`. Download `https://nodejs.org/dist/v<ver>/node-v<ver>-win-x64.zip` and `SHASUMS256.txt`. Require the zip hash to equal both the pinned value and the SHASUMS line. Extract **only** `node.exe` and `LICENSE` to `stage/.../node/`; npm, npx and corepack are left out. Check the Authenticode signature: `Valid` and `CN=OpenJS Foundation`. | any mismatch |
| R6 Server (F2) | In `src`: `npm ci --ignore-scripts`. Then `npm run build:server -w @hayba/mcp`; its `prebuild:server` hook builds the `@hayba/brain-protocol` workspace package first (`mcp-tools/hayba-mcp/package.json:15`, dependency at `:27`). Then the dashboard build (`cd mcp-tools/hayba-mcp/dashboard && npm ci --ignore-scripts && npm run build`), and `npm run audit:production` (root `package.json:23`). Assemble `stage/.../server/`: stamped `package.json` without `scripts` and `devDependencies`; `hayba.agents.json`; `dist/**` without `*.test.*`, `*.map`, `*.d.ts` or `__tests__/`; `dashboard/dist/**`; `Resources/{node_catalog.json,pcgex_registry.db}` from `unreal/HaybaMCPToolkit/Resources/`. **Production closure:** `npm ls --all --omit=dev --parseable --workspace @hayba/mcp`. Copy each listed package directory, keeping its relative `node_modules` nesting. Workspace links are resolved with `realpath` and copied as real directories containing only their `package.json` `files` (for brain-protocol: `package.json` and `dist/`). Strip `*.md` (except LICENSE and NOTICE), `*.map`, `*.d.ts`, `*.ts`, and `test/ tests/ __tests__/ docs/ example/ examples/ .github/`. Generate `THIRD_PARTY_NOTICES.txt` (name, version, licence and licence text for every copied package, plus Node). **Smoke:** the doctor's `runtime.boot` probe against the stage, which catches anything the pruning broke. | build, audit or smoke fails |
| R7 Setup core | Copy `installer/setup/{hayba-setup.mjs,lib/**,hayba.ico}` → `stage/.../setup/`. Run `stage/.../node/node.exe --test installer/setup/test`. | a test fails |
| R8 Package (F5) | Write `runtime-files.json`, then `VERSION` (with `runtimeTreeSha256`, `minPlugin` and `protocol`) and `plugins/index.json`. Zip the payload (`tar.exe -a -cf hayba-<ver>-win-x64.zip hayba-<ver>`). Zip the symbols for each engine. Generate `install.ps1` from the template (with the payload hash and size). Write `latest.json` and `SHA256SUMS`. With front door A: `ISCC.exe /DVersion=<ver> /DPayload=<stage> installer\inno\HaybaSetup.iss`, then sign the exe and uninstaller with a timestamp. | any path inside the payload, relative to the zip root (`hayba-<ver>\…`), is longer than 140 characters. With `%TEMP%\hb-<6>\` (about 40 characters for a typical profile) that keeps extraction under 260 without long-path support. |
| R9 Load tests | §9.6: every required cell. Results go into `build-info.json`. | any required cell fails, or the manual L8 checklist is not recorded for this commit |
| R10 Publish (F5) | `gh release create v<ver> --draft` (a normal release, not a prerelease; Q7) and upload the assets. The maintainer reviews the draft, then `gh release edit v<ver> --draft=false`. **Then** copy `install.ps1` to `website/install.ps1`, `latest.json` to `website/latest.json` and to `website/releases/v<ver>.json` (older `releases/*.json` files stay), and deploy the website. Finally check that `irm https://hayba.vercel.app/install.ps1` contains the new version and a hash that matches `SHA256SUMS`, that both website JSON files match the release asset byte for byte, and run the website link crawler. The order matters: the website must never point at assets that are not published yet. | |

**R3 completeness check.**
- **Non-unity modules** (`bUseUnity=false`, which is the Toolkit, `HaybaMCPToolkit.Build.cs:16`): every `Source/**/<stem>.cpp` has a matching `<stem>.cpp.obj` in the module's intermediate folder. Generated objects (`*.gen.cpp.obj`, `Module.*.cpp.obj`, `PerModuleInline*`) are ignored, because they have no source counterpart. A plain count comparison would always fail: the spike logged 153 compile actions for 147 `.cpp` files.
- **Unity modules** (the satellites use the default unity build): the generated `Module.<Name>*.cpp` unity files together `#include` every `.cpp` in the module's `Source`.
- **Toolkit tests:** L1's `test_list` count equals the count of automation test definitions in the source, so a test file that never compiled can't pass as green.

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

**Fixtures.** Each test starts from a fixture project zip, unpacked into a fresh folder. The zips (`ue<E>-blank-bp.zip`, `ue<E>-blank-cpp.zip`, and the L4 variant) are Blank templates created once per engine with `build-release.mjs --make-fixtures`. They live in `D:\HaybaRelease\fixtures\` on the build host (configurable with `--fixtures <dir>`), not in the repo, and `build-info.json` records each zip's path and SHA256. Every fixture sets `SidecarURL` to a free port in its `Saved\Config\WindowsEditor\EditorPerProjectUserSettings.ini`, so its sidecar and the L1 health check never touch a developer's sidecar on 7821.

**Isolation from the maintainer's machine.** The build host is also a development machine, usually with an editor open.
- Every test runs the core with `--runtime-dir <out>\lt\rt`, `--data-dir <out>\lt\data` and `--registry-root HKCU\Software\HaybaTest-<rand>` (§6.2), and starts the test editor with `HAYBA_HOME` and `HAYBA_DATA_DIR` pointing at those folders. Nothing is written to the maintainer's real runtime, data dir or `HKCU\Software\Hayba`, so G1 never switches the dev editor's Node to a test runtime.
- Preflight blocks only on editors that have a selected project open (§6.5), so the dev editor does not block `install --yes` on a fixture.
- Every test that launches an editor acquires the shared editor gate first and releases it afterwards.
- The test editor's TCP port comes from the 52342–52350 walk; tests read it from the fixture's heartbeat file instead of assuming 52342.

Every test finishes with `doctor --json` as its last step.

**Required cells.** SC6 and R9 require every cell marked *required* below. A cell marked *optional* is run when time allows and recorded either way.

| Id | Engines | Kind | Test | Pass when |
|---|---|---|---|---|
| L1 | each, required | automated | Clean Blueprint-only project: `install --yes --project <p> --payload <stage> --clients none`, then `UnrealEditor-Cmd.exe <p> -ExecCmds="Automation RunTests Hayba;Quit" -unattended -nosplash -RenderOffscreen -log` | exit 0. The log shows the module starting with no "different engine version" or missing-module error, and no "Optional command domains unavailable". A heartbeat file appears. `/api/health` on the fixture's sidecar port reports the release version. The `Hayba` automation filter passes in full, and its test count equals the source definitions (R3; 63 tests at `dc6b4403`; the narrower `Hayba.MCP` filter skips files). A file-system and registry diff shows only the allowed paths (SC2). |
| L2 | each, required | automated | Clean C++ project: same as L1, then `Build.bat <Proj>Editor Win64 Development -Project=<p>` | The build succeeds and the UBT log has **no** compile actions for any Hayba `.cpp` (the installed plugin is used as-is) |
| L3 | 5.8 required; 5.7 optional | automated | Package the L1 project: `RunUAT BuildCookRun -project=<p> -platform=Win64 -clientconfig=Development -cook -stage -pak -archive -noP4` | Packaging succeeds. The log records whether UAT built a game target (answers OV-1). Run once before and once after G9's `TargetAllowList` and keep the fix only if it helps. |
| L4 | each, required | automated | Satellites with the engine plugins off: a project whose `.uproject` sets `GameplayAbilities` and `Metasound` to `"Enabled": false`; `install --satellites gas,metasound` | The Toolkit loads. Record whether the engine plugins end up on (answers OV-2) and correct the satellite descriptions (G9c). |
| L5 | each, required | automated | Upgrade and idempotency: install the previous payload (if one exists), then this one, then this one again | Projects are upgraded and backups exist. The second run of the same version is all `unchanged`, with byte-identical client files (SC3). |
| L6 | one (5.8), required | automated | Uninstall scope: pre-seed an unrelated client entry, an unrelated plugin and a user memory DB; then `uninstall --yes` | Only manifest paths are removed. The unrelated items are byte-identical and the memory DB is kept (SC4). With `--remove-data`, the data dir is gone. |
| L7 | one (5.8), required | automated | Developer link: `Plugins\HaybaMCPToolkit` is a junction (`mklink /J`, which needs no admin) | Result `skip` with the link message. The junction target is untouched. |
| L8 | one (5.8), required | **manual** checklist | Client round-trip: under a throwaway Windows user that has Claude Code and VS Code installed, run `install --clients detected`. Creating that user needs admin, so this cell is a manual checklist, not part of the automated R9 run. | `claude mcp get hayba` reports it connected (health-checked). VS Code lists `hayba`. Uninstall removes both. The maintainer records the result, the date and the commit in `build-info.json`; R9 fails without that record. |

**Before the public exe (not a gate for the tester beta):** a clean VM **without** Visual Studio, which checks "no Visual Studio" end to end; and SmartScreen and antivirus behaviour of the signed exe.

---

## 10. Plugin and server gap fixes

These go on their own branch (`fix/installer-gaps`) **after P0 lands** (§14). Binaries cut before them would bake the problems in. Each fix is small. Class-layout changes need a full rebuild, not Live Coding; after building, confirm with `test_list` that new `.cpp` files are in the binary.

**G1 — Node lookup is narrow**
- *Where:* `HaybaMCPModule.cpp:623-633` (`FindNodeExecutable`). It checks `<Plugin>/ThirdParty/node/node.exe` (:625), then the two Program Files paths (:628-629). No PATH, no version check. It is called at :504.
- *Change:* resolve in this order:
  1. `%HAYBA_HOME%\node\node.exe`;
  2. `HKCU\Software\Hayba\InstallDir` (`FWindowsPlatformMisc::QueryRegKey`) → `<InstallDir>\node\node.exe`;
  3. `<Plugin>/ThirdParty/node/node.exe`;
  4. each `node.exe` on `PATH`;
  5. the Program Files paths.

  For 1–2, read the Node version from `<dir>\VERSION` `node`; no process is started. For 3, the plugin's own `ThirdParty` Node is trusted as shipped. Only when 1–3 all miss does the plugin probe 4–5 with `node --version`:
  - `FPlatformProcess::ExecProcess` has no timeout, and version-manager shims (nvm, Volta) can stall, so the probe uses `CreateProc` with a pipe plus `WaitForProc` polling with a 3 s deadline, and `TerminateProc` on timeout;
  - it runs on a thread-pool task, never on the game thread. The sidecar start continues from a game-thread task when the probe finishes; nothing on the game thread waits for it;
  - the result is cached for the session.

  Reject anything below 22.13.0 (OV-3) with the log line "Skipping `<path>`: Node `<v>` is older than 22.13". Log the chosen path and version. Return an absolute path. The lookup is shared with G2 in `HaybaRuntimeLocator`.
- *Acceptance:*
  - An automation test `Hayba.Installer.RuntimeLocator` with injected probes covers the order and the version rejection.
  - With the runtime installed and no system Node, the sidecar starts, and the log shows `Node: <InstallDir>\node\node.exe (24.x)`.
  - With only Node 22.12 on PATH, Node is rejected, and the panel says "Node.js 22.13 or newer not found — run the Hayba installer".

**G2 — Server lookup: add the shared runtime; launch `bootstrap.js`**
- *Where:* `HaybaMCPModule.cpp:635-678` (`GetMCPServerPath`). Every candidate ends in `dist/index.js` (:650, :666, :675). `bootstrap.ts:8-11` installs console secret redaction **before** it dynamically imports `index.js`, so launching `index.js` directly skips redaction of import-time output.
- *Change:* the order becomes:
  1. override (:638-643);
  2. repo dev build (:648-655);
  3. symlink-resolved dev build (:657-672);
  4. `<HAYBA_HOME or InstallDir>\server\dist\bootstrap.js`;
  5. `<Plugin>/ThirdParty/mcp_server/dist/bootstrap.js`.

  All candidates use `bootstrap.js`, and all are made absolute.
- *Acceptance:*
  - With the installed runtime and a project copy, the log shows "MCP server entry (installed runtime): …\bootstrap.js".
  - The dev symlink layout still resolves the repo build.
  - A secret-shaped string printed at import time comes out redacted in `HaybaSidecar.log` (together with G3).

**G3 — The sidecar runs in the wrong working directory; logs are discarded; stores are cwd-relative**
- *Where:* `FPlatformProcess::CreateProc(*NodePath, *Params, false, true, true, &ProcessID, 0, nullptr, nullptr, nullptr)` at `HaybaMCPModule.cpp:535`: the working directory is `nullptr` and there are no pipes. The environment is set at :521-531. The server resolves these stores from `process.cwd()`:
  - `tools/routing/register.ts:161-163` (tool-index cache);
  - `tools/routing/settings-watcher.ts:12-15` (`settings.json`);
  - `tools/disabled-tools-watcher.ts:14-21`;
  - `plumb/constraint-store.ts:16`, `grammar-store.ts:16`, `lesson-store.ts:24`, `profile-store.ts:16`, `study-requests.ts:19`;
  - `validator/config.ts:43`, `validator/history.ts:18`, `tools/validator/tools.ts:267`, `tools/plumb/tools.ts:68`;
  - `tools/execute-pcg-graph.ts:34`, `tools/asset-retriever/meta-tools/browse.ts:41,51`, `tools/python-run-validator-wrap.ts:29`;
  - `chat/session-store.ts:90` (chat sessions).

  With the editor started from the Launcher, the working directory is `<Engine>/Binaries/Win64`, so these land inside the engine. They are shared across projects, and they diverge from `<Project>/Saved/HaybaMCP`, where the plugin writes.
- *Change (plugin):*
  - pass the absolute project directory as the working directory;
  - set `HAYBA_PROJECT_DIR` to the project directory;
  - set `HAYBA_LOG_FILE` = `<Project>/Saved/Logs/HaybaSidecar.log`.
- *Change (server):*
  - `bootstrap.ts` tees the already-redacted console output to `HAYBA_LOG_FILE`, keeping the previous run as `HaybaSidecar-prev.log`.
  - A new `src/paths.ts` exports `projectDir()`. It returns `HAYBA_PROJECT_DIR`; otherwise the nearest ancestor of the working directory that contains a `.uproject` (at most 8 levels, the same bound as `tcp-client.ts:174`); otherwise `null`.
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

**G5 — Port 7821 reuse is blind; no runtime/plugin compatibility contract (version handshake)**
- *Where:*
  - `HaybaMCPModule.cpp:266-281` reuses whatever accepts a TCP connection on the sidecar port (:273, 0.25 s probe).
  - `/api/health` (`dashboard/api.ts:39-49`) returns no version.
  - `index.ts:68` hardcodes `v1.0.0`, and `mcp-tools/hayba-mcp/package.json:3` says `1.0.0`, while every `.uplugin` says `VersionName` `0.3.0`. In the dev layout the two never match.
  - Nothing ties the shared runtime (always the newest on the machine) to per-project plugin copies, which can stay old: Perforce read-only copies are refused (§6.9), projects sit on unplugged drives, some copies are unmanaged. A newer server can call commands an older plugin lacks.
- *Change (versions):* set the source server `package.json` `version` to the plugin's `VersionName` (`0.3.0` today), and add a unit test that fails when the two differ. R2 then stamps both to the release version, and the server version no longer drops from `1.0.0` to `0.4.0` at release time.
- *Change (contract):*
  - The server source holds two constants in a new `src/compat.ts`: `MIN_PLUGIN` and `PROTOCOL`. R8 copies them into `VERSION` as `minPlugin` and `protocol` (§8.1). The plugin has a matching constant `HAYBA_PLUGIN_PROTOCOL`. A change that needs new plugin commands raises `MIN_PLUGIN`; a wire-format change raises both protocol constants.
  - The TCP `ping` reply (already used by `tcp-client.ts:328` and `dashboard/api.ts:92`) adds `pluginVersion` and `protocol`. A reply without them counts as protocol 0, which is incompatible.
  - The server checks them on every new editor connection. If the plugin's `VersionName` is below `MIN_PLUGIN`, or its protocol differs, every tool call returns: "This project's Hayba plugin (`<a>`) is older than the Hayba runtime (`<b>`). Re-run the Hayba installer for this project." Nothing is sent to the editor.
  - The plugin reads `<InstallDir>\VERSION` before it starts a sidecar from the runtime. If `minPlugin` is above its own `VersionName`, it does not start the sidecar and shows the same message. If the runtime is older than the plugin (a teammate got a newer copy through source control), it shows "The Hayba runtime (`<b>`) is older than this project's plugin (`<a>`). Run the Hayba installer."
  - Doctor reports an incompatible copy as FAIL (§6.11).
- *Change (server health):*
  - `/api/health` adds `product:"hayba"`, `version` (read once from `package.json`), `pid`, `execPath` and `projectDir`.
  - The startup log uses the same version.
- *Change (plugin, sidecar reuse):* when the port is reachable, send an asynchronous `GET /api/health` (FHttpModule, 1 s timeout).
  - **Not Hayba:** warn "Port 7821 is used by another program. Change Sidecar URL in Hayba settings." Do not start.
  - **Hayba, same version and same `projectDir`:** reuse it.
  - **Hayba from a dev layout** (its `execPath` is outside `InstallDir` and the plugin's `ThirdParty`): reuse it and log the versions, without a notice, so developers are not nagged on every start.
  - **Otherwise:** notify "A Hayba sidecar from another version or project is running on port 7821", with **Restart sidecar** and **Ignore**. Restart does not trust the `execPath` the listener reports about itself. It asks the OS: the pid must own the listening socket (`GetExtendedTcpTable`), and its real image path (`QueryFullProcessImageName`) must be under `InstallDir` or the plugin's `ThirdParty`. Only then does it call `FPlatformProcess::OpenProcess` + `TerminateProc` and start a new sidecar.
- *Acceptance:*
  - An automation test covers the decision table: not-Hayba, same, dev layout, version differs, project differs.
  - An automation test covers the contract: plugin below `minPlugin`, protocol mismatch, runtime older than the plugin.
  - A server unit test covers the `ping` check and the error text.
  - Manually: run an older sidecar, then open a newer editor. The notice appears, and Restart replaces the sidecar.

**G6 — `HAYBA_BRAIN_URL` passthrough**
- *Where:* nothing under `unreal/` sets it. The server reads `process.env.HAYBA_BRAIN_URL` (`config.ts:106`).
- *Change:*
  - Add a per-project setting `BrainURL`, empty by default, stored in `GEditorPerProjectIni` beside `bAutoStartSidecar` and `SidecarEntryPath` (`HaybaMCPSettings.cpp:286-287`).
  - When it is not empty, set `HAYBA_BRAIN_URL` before `CreateProc`. It must be HTTPS, or `http://127.0.0.1` / `localhost` for development.
  - Never clear a value inherited from the user's environment.
  - The installer never sets it in v1.
- *Acceptance:* with the setting on, the sidecar logs "brain URL configured: `<origin>`". With it empty, nothing changes.

**G7 — The server writes into its own package folder**
- *Where:*
  - `config.ts:84`: the memory DB defaults to `<pkg>/data/hayba-memory.db`.
  - `tools/scrape-node-registry.ts:18,213,287`: the scrape writes the registry and catalog next to the shipped resource that `resolveResource` finds (`config.ts:21-39`).
  - `tools/docs/query-ue-docs.ts:76`: the UE docs DB defaults to `<pkg>/data/ue-docs-5.7.sqlite`, which a runtime swap would wipe.
  - The server also writes under `%USERPROFILE%\.hayba\`: `conventions.ts:120` (`conventions.json`), `dag/index.ts:43` (`default\`), `projects.ts:16` (`projects\`) and `tools/asset-retriever/asset-indexer.ts:9` (`cache\retriever-tags.json`).
  - `gaea/memory/hayba-memory.ts:66` opens the DB with no busy timeout and no journal mode, so two processes writing at once get `SQLITE_BUSY`.
- *Change:* `dataDir()` in `src/paths.ts` returns:
  1. `HAYBA_DATA_DIR`;
  2. in the dev layout (the package root has `src/` and `tsconfig.json`), today's `<pkg>/data`;
  3. otherwise `%LOCALAPPDATA%\Hayba`.

  Consequences:
  - The memory DB defaults to `<dataDir>\memory\hayba-memory.db`, the same path the installer writes into client entries. The plugin-started sidecar and the client-started servers therefore share one memory. The store opens it with `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000`.
  - The scrape defaults to `<dataDir>\pcgex\`.
  - `resolveResource` checks `<dataDir>\pcgex\` after the environment overrides and before the shipped candidates. A user scrape then overrides shipped data without writing into the runtime.
  - The shipped DBs in `server\Resources\` are found by the existing candidate at `config.ts:29`.
  - `HAYBA_UE_DOCS_DB` defaults to `<dataDir>\docs\ue-docs-5.7.sqlite`.
  - The four `~/.hayba` users write under `<dataDir>` with the same relative names. Each still reads the old `%USERPROFILE%\.hayba\` path when the new one does not exist yet, so existing users keep their conventions and projects. Nothing is deleted from the old folder.
  - The server also resolves user slivers from `%APPDATA%\Hayba\slivers` (`slivers/loader.ts:109-111`). The installer neither creates nor removes that folder.
- *Acceptance:*
  - With the runtime folder made read-only (`icacls /deny`), memory writes, a scrape, a conventions save and a docs rebuild all succeed into `%LOCALAPPDATA%\Hayba`, and nothing is written to `%USERPROFILE%\.hayba\`.
  - Two server processes writing memory in a loop for 60 s see no `SQLITE_BUSY` (the OV-13 stress test becomes this criterion).
  - The dev checkout behaves as before, and its tests pass.

**G8 — `engines` is too loose for `node:sqlite`**
- *Where:*
  - `mcp-tools/hayba-mcp/package.json:46-47` and root `package.json:11` say `">=22.5.0"`.
  - `node:sqlite` is loaded at module scope through `createRequire`, in `gaea/memory/hayba-memory.ts:14` and four other modules.
- *Change:*
  - Set `">=22.13.0"` (OV-3).
  - Add a version guard to `bootstrap.ts`: "Hayba needs Node.js 22.13 or newer (found X). The Hayba installer includes a suitable Node." Then exit 1. ESM evaluates static imports before the module body, so the guard can't run "before any other import". It goes in the body, after `installConsoleSecretRedaction()` and before `await import('./index.js')`. That is early enough, because `node:sqlite` is reached only through `index.js`.
  - A unit test asserts that `security/secret-redaction.ts` imports nothing that loads `node:sqlite`.
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
- *Where:* `mcp-tools/hayba-mcp/package.json:28` (`@distube/ytdl-core`), `:30` (`cheerio`) and `:36` (`youtube-transcript-api`). Nothing imports them. The only reference is a type declaration, `src/gaea/scripts/youtube-transcript-api.d.ts:1`.
- *Change:*
  - Remove the three dependencies and the orphaned `.d.ts`.
  - The builder copies the `@hayba/brain-protocol` workspace package as a real directory (R6).
- *Acceptance:*
  - `npm ls --omit=dev -w @hayba/mcp` no longer lists them.
  - Typecheck and tests pass.
  - The production closure size is recorded in `build-info.json`.

**G11 — User-level instance registry: out of v1 (Q9), recorded for a later release**
- *Problem:* the heartbeat is written only to `<Project>/Saved/HaybaMCP/instances/<pid>.json` (`HaybaMCPModule.cpp:454-468`). The server uses `UE_TCP_PORT` when set, otherwise walks up from its working directory for that file, otherwise dials 52342 (`tcp-client.ts:222-227`, walk at :149-217). A server started by Claude Desktop, Cursor or VS Code has a working directory outside any project, so with two editors open it takes the first port, and it never learns the project directory.
- *Later change:* the plugin also writes the heartbeat to `%LOCALAPPDATA%\Hayba\instances\<pid>.json`, and the server scans that folder after the walk.
- *v1:* one open editor works. With several, the server connects to the editor on 52342, and its per-project stores fall back to `<dataDir>\scratch` (G3). The download page says so.

### 10.1 UE 5.7 support work (Q2)

The spike ran against `dd98e537`. The five files that hold the 8 sites are unchanged at `dc6b4403` and at `a5ceaa40` (`git diff` is empty for all five; the cited lines were re-read at `a5ceaa40`). The other changes since then have not been compiled on 5.7, so Phase 1 starts by running the 5.7 compile gate on its base.

| # | Root cause | Sites | Fix |
|---|---|---|---|
| 1 | Five `EMaterialUsage` values exist only in 5.8 | `handlers/HaybaMCPMaterialHandler.cpp:2565-2569`, `Tests/HaybaMCPMaterialUsageTest.cpp:127-131` | `#if UE_VERSION_NEWER_THAN_OR_EQUAL(5, 8, 0)` around the five entries in both tables. On 5.7, `material-set-material-property.ts` is engine-aware or documents that the five keys are unavailable, with a TS test. |
| 2 | `UMaterial::SetUsageByFlag` is private in 5.7 | `HaybaMCPMaterialHandler.cpp:2762`, `:2778` | A shim below 5.8 that writes the public `bUsedWith*` bitfields (mirroring 5.7's own `Material.cpp` switch) **and** calls `FEditorSupportDelegates::MaterialUsageFlagsChanged.Broadcast(Mat, Usage)`, as 5.7's own body does. Without the broadcast, an open Material Editor keeps stale usage flags, and its **Apply** overwrites the MCP change. |
| 3 | `RecompileMaterial` returns `void` in 5.7 | `HaybaMCPMaterialHandler.cpp:3167` | `#if`. On 5.7, read `GetMaterialResource(GMaxRHIShaderPlatform)->GetCompileErrors()`. |
| 4 | The `FJsonObject::Values` key type differs between engines | `HaybaMCPSecretRedaction.cpp:580` | A portable form: `FStringView RawKey(*Pair.Key, Pair.Key.Len())` |
| 5 | `EGetObjectsFlags` exists only in 5.8 | `handlers/HaybaMCPUILayout.cpp:198`, `Tests/HaybaMCPUIPreviewLifetimeTest.cpp:252` | Drop the argument. The default includes nested objects on both engines. |

Also:
- `#include "Misc/EngineVersionComparison.h"` where the guards are used. It exists on both engines. A raw `ENGINE_MINOR_VERSION >= 8` check would break on UE 6.x.
- A **5.7 compile gate** (`build-release.mjs --compile-only --engines 5.7`, about 3 minutes) before merging plugin changes. The five breakages above arrived within two days without anyone noticing. Hosted runners have no engines, so the gate needs a local trigger: a pre-push hook that runs it when `unreal/**` changed.
- The full `Hayba` automation run on both engines.
- A **5.7 tool sweep**: a raw-TCP smoke test of the ~355 callable commands against a 5.7 editor, with fixtures authored on 5.7 (5.8-saved assets don't load there). Python-template and reflection-by-name tools are invisible to the compiler, and only this sweep catches their drift.
- Satellite smoke tests on 5.7 by hand: GAS has no automation tests and MetaSound has one.

The satellites and all `.uplugin` and `Build.cs` files already build on 5.7.

---

## 11. Security

- **HTTPS only.**
  - Downloads come from the website (`hayba.vercel.app`: `install.ps1`, `latest.json`, `releases/v<ver>.json`), from `github.com` (redirected to `release-assets.githubusercontent.com` or `objects.githubusercontent.com`), and, on the build host, `nodejs.org`.
  - `http://` URLs are refused, and so are asset URLs outside `https://github.com/zajalist/hayba/releases/download/`.
  - Certificate checks are never skipped. Downloads use the Windows certificate store and proxy settings (§6.1).
- **Threat model.**
  - *The one-liner trusts the website.* `irm | iex` runs whatever the website serves, so whoever controls `hayba.vercel.app` controls the one-liner. No hash can change that. The signed `HaybaSetup.exe` (Phase 4) removes that trust for the public path.
  - *A compromised GitHub release alone can't run code.* `install.ps1` embeds the payload SHA256 and size, so a swapped release asset fails the check.
  - *`update` and `install.ps1 -Version` need both origins.* The expected hash comes from the website's `latest.json` or `releases/v<ver>.json`, and it must equal the line in GitHub's `SHA256SUMS`. Tampering with one origin fails the check; it takes both.
  - The builder pins the Node zip hash in the repo and cross-checks it against `SHASUMS256.txt`.
  - `install.ps1` checks that `node.exe` carries a valid OpenJS Foundation Authenticode signature before running it, and the core then verifies every runtime file, `node.exe` included, against `runtime-files.json`.
  - The payload is extracted only after its hash matches, and extracted paths are checked to stay inside the destination.
  - Signing `latest.json` and `SHA256SUMS` with a key embedded in the core would remove the website from the `update` trust path. It is not in v1; it belongs with the opt-in self-updater (Q6).
- **No admin.**
  - Everything is per user: `%LOCALAPPDATA%` and HKCU.
  - The core and `install.ps1` refuse an elevated process unless `--allow-elevated` / `-AllowElevated`, which is accepted only when the elevated user is the interactive user (the owner of `explorer.exe`). An elevated run can otherwise belong to a different user (over-the-shoulder UAC credentials), and it would install into that user's profile.
  - Inno runs with `PrivilegesRequired=lowest`.
  - The Advanced engine-location install writes into a folder every local user can write (§6.9), so the core tightens the ACL on the installed plugin folders.
- **Never overwrite a symlink or junction.**
  - Plugin directories that are links, or that sit under a linked `Plugins\`, are skipped.
  - A config file that is a symlink is written through to its target, never replaced by a regular file.
  - Every recursive delete goes through `safeRemove` (§6.12).
- **Never log keys.**
  - The core never reads provider keys; they live in the plugin's DPAPI vault.
  - Client-config writers touch only the `hayba` entry and never log or print other entries, because their `env` may hold other tools' secrets.
  - Config backups are byte-for-byte copies and can hold those secrets, so only the last 3 per client are kept and uninstall deletes them (§5.2, §6.12).
  - The doctor report redacts the user folder, the user name and OneDrive organisation names, and lists only Hayba's two environment keys.
  - The sidecar log is written through `bootstrap.ts`'s console redaction (G2, G3).
- **Uninstall scope.** Only manifest paths, plus `hayba` client entries that are ours (recorded in the manifest, or pointing into `<rt>`). User data stays unless `--remove-data`. Other entries, plugins and project files are never touched.
- **Process control.** The core kills only `node.exe` processes whose image is under `<rt>\node\`, never its own process or its ancestors. It never kills Unreal Editor or any other program. The plugin's Restart sidecar checks the pid's real image path and port ownership with the OS before terminating it (G5).
- **System tools.** Every Windows tool is called by its absolute `%SystemRoot%\System32` path, and PowerShell with `-NoProfile -NonInteractive` (§6.1).
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
- **Privacy.** The update check is one HTTPS GET of a static file from the website, with no telemetry. It can be turned off (`bCheckForUpdates`).
- **Temporary files.** They go in freshly created, randomly named `%TEMP%\hb-*` folders and are deleted after use; a folder a core is still running from is deleted by a later run (§6.6).

---

## 12. Error handling by step

| Step | Failure | User-facing message | Exit / result |
|---|---|---|---|
| Environment | Elevated | "Run the installer from a normal (non-admin) PowerShell window. Hayba installs for your user only and never needs admin rights. If this is your only account, add -AllowElevated." | 9 |
| Environment | `node.exe` blocked by AppLocker/WDAC (Win32 error 1260) | "Your organisation blocks programs in AppData, so Hayba can't run here. Ask IT to allow it, or build Hayba from source: https://hayba.vercel.app/docs/#build-from-source." | 9 |
| Environment | `runtime` part requested from inside `<rt>` | "Run the installer or `update` to change the Hayba runtime." | 2 |
| Environment | Not x64, or an old Windows | "Hayba supports 64-bit Windows 10 (1809 or later) and Windows 11 on x64 PCs." | 9 |
| Lock | Another setup is running | "Another Hayba setup is already running (PID n). Wait for it to finish." | 3 |
| Download (ps1/update) | Network | "Couldn't download Hayba: `<reason>`. Check your connection or proxy and try again." | 11 |
| Download | Size mismatch after one retry | "The download was incomplete. Check your connection and try again." | 11 |
| Download | Certificate error | "Your network inspects HTTPS traffic, and Windows does not trust the certificate it presented. Download the zip from the release page and run install.ps1 -PayloadPath." | 11 |
| Download (ps1) | Low disk on `%TEMP%` | "Free at least `<n>` MB on `<drive>` and run this again." | 6 |
| Download | Hash mismatch | "The download does not match the published checksum. Nothing was installed. Try again later; if it keeps happening, report it." | 5 |
| Preflight | Editor running | Interactive: "Unreal Editor is running (`<projects>`). Save your work and close it, then press Enter (Ctrl+C cancels)." With `--yes`: "Close Unreal Editor and run the installer again." | 3 |
| Preflight | Our Node would not stop | "Couldn't stop a Hayba server (PID n). Close the AI apps that use Hayba and try again." | 3 |
| Preflight | 7821 foreign | Warning, §6.5 | 0 (a warning never changes the code) |
| Preflight | Project path too long | "`<project>`'s folder path is too long for Windows to hold Hayba's files. Move the project to a shorter path, or turn on Windows long paths." | failed → 7 (5 if it is the only item) |
| Preflight | Low disk | "Hayba needs about 400 MB free on `<drive>`; `<n>` MB is free. Free at least `<m>` MB." | 6 |
| Runtime | Downgrade with `--yes` | "This payload is older than the installed Hayba `<x>`. Pass --allow-downgrade to go back." | 5 |
| Runtime | Write or rename failed | "Couldn't install the Hayba runtime in `<dir>`: `<reason>`. Your previous installation was restored." | 6 |
| Runtime | Locked file (antivirus) | "Windows is holding `<file>` open (often antivirus scanning it). Wait a minute and run the installer again." | 6 |
| Engines | None supported | "No supported Unreal Engine found. Hayba needs Unreal Engine 5.7 or later from the Epic Games Launcher (this release: `<engines from plugins/index.json>`)." | 4 (unless `--only clients`) |
| Engines | Source build | "`<root>` is built from source. Prebuilt Hayba only matches Launcher engines. Build Hayba from source for this engine: https://hayba.vercel.app/docs/#build-from-source." | reason on the engine |
| Engines | BuildId mismatch | "UE `<ver>` at `<root>` has build ID `<a>`, but this Hayba release was built for `<b>`. Update Hayba or the engine so they match." | explicitly requested: failed → 7 (5 if it is the only item); otherwise skip |
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
| Clients | CLI error | "`claude mcp add-json` failed (exit n): `<first stderr line>`." plus the manual command. A replaced entry is restored from its snapshot. | failed → 7 |
| Clients | Foreign `hayba` entry kept (`--yes`) | "Your `<client>` config already has a 'hayba' entry that runs `<command>`. Hayba left it alone; run with -Clients `<id>` interactively, or pass --replace-foreign, to replace it." | kept (0) |
| Clients | Claude Desktop running (`--yes`) | The after-message: "Quit Claude Desktop from the system tray (closing the window is not enough), then start it again." | ok (0) |
| Clients | File locked | §6.10.1 step 7 | failed → 7 |
| Doctor | Any FAIL | The check's fix text (§6.11) plus "Copy the report below into an issue if you need help." | install 7, doctor 8 |
| Doctor | Plugin copy below the runtime's `minPlugin` | "This project's Hayba plugin (`<a>`) is too old for the installed runtime (`<b>`). Run: `<install --only projects --project … command>`" | FAIL |
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
  - `FakeNet`: canned `latest.json`, `SHA256SUMS`, health responses and download bytes. It can replay a redirect chain, including the real one (`github.com` → `release-assets.githubusercontent.com`), and truncate a download.
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
  - `.uproject` files with a UTF-8 BOM, and a UTF-16LE `.uproject` with a BOM and a Japanese description (read, and edited in the Advanced path, in its original encoding);
  - a project with `Plugins\HaybaMCPToolkit` as a link, as a copy, and absent;
  - one project reached through RecentlyOpened (forward slashes), `CreatedProjectPaths` and `Unreal Projects` (one merged entry with three `via`), and two different projects named `MyGame` (both shown with their parent folder);
  - a manifest project whose drive is missing (`state:"missing"`, kept);
  - ignore rules: a UE-style `.gitignore` (`ignoresBinaries` true), none (`null`).
- **Config writers** (each client), all asserted byte-for-byte:
  - missing file and missing folder;
  - `{}`;
  - a UTF-8 BOM (kept);
  - CRLF (kept);
  - comments and trailing commas (JSONC; kept);
  - unknown top-level keys and other servers (byte-identical outside `hayba`);
  - an existing identical `hayba` (no write, no backup);
  - an existing different `hayba` that is ours (replaced, backed up);
  - a foreign `hayba` pointing at a repo build: interactive No and `--yes` keep it (`kept`); `--replace-foreign` replaces it with a backup;
  - backup pruning (the newest 3 per client are kept);
  - a UTF-16LE file (written back as UTF-16LE);
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
  - a different entry (snapshot, remove, then add);
  - add fails after the remove (the snapshot is re-added; result `failed`);
  - a `claude.exe` whose `--version` is not Claude Code (Claude Desktop's image; skipped);
  - a project-scope override (warning).
- **Claude Desktop running:** detected by image path; interactive waits for the quit; `--yes` writes and reports the after-message.
- **Idempotency property:** `apply` twice gives `unchanged` the second time, and the file is byte-identical after the second run.
- **Plugin copy:** link refusal (`Plugins` or the plugin directory), read-only refusal, BuildId refusal, `unchanged` when the tree hash matches, rollback when the Nth rename fails across the whole set (Toolkit and satellites all equal the original), backup pruning (keeps 2), stale Niagara/Sequencer moved to backup, a stale satellite that is a junction left alone, the locked-set upgrade of existing satellites, leftover `s-*` staging cleaned, the long-path skip, and a downgrade (refused with `--yes`, allowed with `--allow-downgrade`).
- **Runtime swap:** rollback at each rename index; `VERSION` deleted first and written last; a crash injected after each rename, then a new run: reconcile restores from `.old-<id>` (target missing) or marks `done` (new `VERSION` present), and only then deletes leftovers; downgrade prompt, refusal (5) and `--allow-downgrade`.
- **Self-protection:** `stopOurNodes()` never lists the core's pid or its ancestors; `install --only projects,clients` from inside `<rt>` works with `<rt>` as the payload and stops no Node process; `install` with `runtime` from inside `<rt>` exits 2.
- **Hand-offs:** `update` releases the lock, starts the new core detached with `--wait-pid`, and exits 0; the new core waits for that pid, then takes the lock. The uninstall relaunch from `<rt>` does the same. `--front-door inno` uninstall runs in place and leaves `node\`.
- **Lock:** a live holder → 3; a dead holder → stolen; a reused pid with a different creation time → stolen.
- **Manifest:** save → load round-trip equality; intent recorded before the write (a crash injected after the intent still leaves an uninstallable record); pending client entries reconciled; unknown schema refused.
- **Uninstall scope:** only recorded paths are removed; plugin folders are renamed into `Saved\HaybaSetup\rm-*` on the project's own volume (never into `%TEMP%`) and then removed; an unrecorded `hayba` entry pointing outside `<rt>` is kept; a path that became a link is skipped; `safeRemove` rejects paths outside the allowed roots (it throws and deletes nothing); backups always removed; memory and logs kept unless `--remove-data`.
- **CLI:** every flag; unknown flag → 2; the exit-code table (each code produced by a scripted scenario); the precedence order (§6.2) with mixed outcomes, for example one explicit unsupported project plus one success → 7, the same project alone → 5, a foreign 7821 listener → 0; `--plan` writes nothing but the `--out` file (the MemFs diff shows only that file); `--json` result snapshots.
- **Update:** hash agreement (website `latest.json`, `SHA256SUMS`, the file), disagreement → 5, a truncated download → one retry, then 11; the real redirect chain accepted; a final host outside the list → 11; `minSetup`; a URL outside the allowed prefix is rejected; the hand-off flags are passed through.
- **Doctor:** the renderer redacts the user folder, a bare user name on another drive, and a OneDrive organisation name, and never prints other entries (SC7); the boot probe's environment (closed `UE_TCP_PORT`, temp project and data dirs); the check matrix, including FAIL for a copy below `minPlugin`.

**Real Windows file-system tests** (any Windows machine, including a hosted Windows runner; no engine needed):
- junction detection with `mklink /J` (needs no admin);
- atomic `rename` over an existing file;
- the read-only attribute;
- `reg.exe` against `HKCU\Software\HaybaTest-<rand>` (always cleaned up);
- `tar.exe` extraction and the check that paths stay inside the destination;
- the elevated-process check;
- non-ASCII paths (a user folder and a project folder with `ö` and `日本`) through the PowerShell registry and process queries;
- a non-English display language (for example de-DE, where `netstat` prints `ABHÖREN`): the port-owner query still finds the listener;
- the Advanced-install ACL: after `icacls`, Users have read and execute only, and inheritance is off.

**install.ps1 tests:** run under both `powershell.exe` 5.1 and `pwsh` 7 with `-PayloadPath` pointing at a local zip:
- the good hash → exit 0;
- a bad hash → 5, nothing written;
- a wrong size → one retry, then 11;
- the PowerShell session survives (no `exit`);
- a Constrained Language Mode simulation → 9;
- 32-bit PowerShell on 64-bit Windows (`SysWOW64\WindowsPowerShell`) is accepted;
- an elevated session → 9, and `-AllowElevated` as the same user → continues with a warning;
- `-Version` with the website and `SHA256SUMS` hashes disagreeing → 5.

**Plugin automation tests** (`Hayba` filter):
- `Hayba.Installer.RuntimeLocator` (G1 and G2 ordering, version rejection);
- the G4 no-toast case;
- the G5 decision table and the compatibility contract (`minPlugin`, protocol, runtime older than the plugin);
- update-notice version comparison and `notesUrl` validation;
- the ClientConnect result parsing.

**Load tests:** §9.6, as the release gate.

**Doctor:** at the end of every install, and as the last step of every load test.

---

## 14. Delivery phases

**Prerequisite: the P0 safety train lands on main.** Installable binaries must contain it, because handing pre-P0 binaries to strangers ships known editor crashes. On 2026-09-28, `fix/p0-safety` is 17 commits ahead of `origin/main` and not merged.

**Early start.** The brief allows only two things before P0 lands: the load-test design and the 5.7 compile spike, and both are done. The default is therefore to wait. Two early starts need the maintainer's explicit OK: the pure-JS setup-core modules with fake-based tests (no plugin edits), and signing procurement (paperwork only; certificate lead time is the longest pole for Phase 4).

| Phase | Ships | Gate | Plan |
|---|---|---|---|
| **1. Gap fixes and 5.7 portability** | G1–G10 (§10) on `fix/installer-gaps`, branched from the P0 merge commit: the G5 compatibility contract and the source version alignment included. The §10.1 guards, the 5.7 compile gate with its pre-push hook, the 5.7 tool sweep and the satellite smoke tests. Optional, if the maintainer pulls it in: the update notice (§7.3). | P0 merged. Full rebuild, not Live Coding, plus the `test_list` check. The shared editor gate for every editor run. Coordination with the lanes that touch `HaybaMCPModule.cpp`. | First plan |
| **2. Release builder** | `build-release.mjs` R0–R10 (§9), the payload, `runtime-files.json`, `SHA256SUMS` and `latest.json`, the fixtures (`--make-fixtures`) and the load-test harness L1–L8 with its isolation rules (§9.6). The first internal payload. | Phase 1 binaries for R3, R4 and the load tests. The runtime half (R5–R8) can be built and tested without UE while Phase 1 runs. | First plan |
| **3. Setup core and `install.ps1` → tester beta** | The setup core (§6), `install.ps1` (§7.1), the manifest, entry and result schemas (§8.5–8.7), and the unit, real-Windows and `install.ps1` tests (§13). `website/install.ps1`, `website/latest.json` and `website/releases/v<ver>.json`. An "Install (beta)" docs section, including the `#build-from-source` anchor that error messages link to (`https://hayba.vercel.app/docs/#build-from-source`). The first release published to invited testers. | A Phase 2 payload for end-to-end runs. | First plan |
| **4. Public installer** | Inno Setup script (§7.2) with its fixed `AppId`, signing with the chosen provider's timestamp URL, the website download page, and the clean-VM pass (§9.6). | Phase 3; a certificate (OV-5); OV-16. | Later plan |
| **5. In-editor surface** | "Connect AI client" and, unless it moved into Phase 1, the update notice (§7.3), in a plugin release. | Phase 3's core in the installed runtime. | Later plan |

**The first implementation plan covers Phases 1–3 and ends with the tester beta.** Its tasks are grouped by phase in gate order, and each phase's gate is a checkpoint inside the plan. Phases 1–3 form one sequential path to the first thing testers can use; Phases 4 and 5 wait on outside gates (a certificate, a plugin release) and get their own plans. The plan is written now and starts when P0 lands. Its first two tasks are:
1. Rebase `feat/installer` onto the P0 merge commit, re-check every citation in this spec, and run the 5.7 compile gate on that base, which confirms Q2.
2. Copy `detect-probe.mjs` into `installer/setup/lib/engines.mjs` (§6.7).

**Download page** (`website/download/`, Phase 4; the tester beta uses the docs section):
- a button to the latest `HaybaSetup.exe`;
- the SHA256;
- the one-liner with a copy button;
- a SmartScreen note while the installer has no reputation yet;
- troubleshooting (`doctor`);
- uninstall steps, including that one `%TEMP%\hb-*` folder can stay behind until the next run;
- the teammate recipe for projects in source control (§6.9);
- the one-editor limit for AI apps in v1 (G11);
- the text "Unreal Engine 5.7+". If Q2's fallback triggers, it shows the one fallback string `FALLBACK_57` (§3).

The page names no other products except the supported AI apps. Deploy with the clean-worktree recipe, then run the link crawler.

**Docs:**
- Replace the clone-and-symlink guide with the installer, and keep build-from-source as an appendix.
- `docs/getting-started.md:63-64` says `uv sync --extra gpu` and "listens on :7821". CLIP needs `--extra embed`, and the visual server now listens on 7822 (`server.py:97`, `tools/visual/sidecar-client.ts:1`).

**Licensing:** ship Node's `LICENSE` and `THIRD_PARTY_NOTICES.txt` (R6).

---

## 15. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| SmartScreen "Unknown publisher"; antivirus flags a bundle carrying `node.exe` | Extra clicks; blocked installs | Beta via the one-liner. Sign before the public exe. Ship Node unmodified with its OpenJS signature. The doctor and the download page explain the prompt. Submit false positives to the vendors. |
| File locks: the editor, a client-started server, or antivirus | Failed upgrades | Preflight closes and stops only what is ours. Renames are retried with backoff. Rollback. Clear messages. |
| Projects under version control (Perforce makes files read-only) | Failed copies | Detect read-only files and refuse per project, with a check-out hint. Never run a VCS write. |
| Teammates get the plugin through source control without its DLLs (UE's `.gitignore` ignores `Binaries/`) | "Missing modules, rebuild?" in a Blueprint-only project, which fails without Visual Studio | Detect the ignore rule; the summary, doctor and download page give the teammate recipe or the exact negation lines (§6.9). |
| Version skew between the shared runtime and an older project copy | Tool calls to commands the plugin lacks | Upgrade every manifest project together. The G5 contract (`minPlugin`, protocol) turns an incompatible pair into one clear message on both sides. Doctor FAILs an incompatible copy. |
| The 5.7 code drifts again on main | 5.7 builds break at release time | The 5.7 compile gate (§10.1). R3 builds every engine. |
| 5.7 runtime differences not seen by the compiler (Python templates, reflection by name, Slate and PIE input behaviour) | 5.7 users hit tool errors | A full `Hayba` automation run on 5.7 (L1), the 5.7 tool sweep of the ~355 callable commands (§10.1), and the Q2 fallback rule. (`TryGetBool` was an earlier example here; it behaves the same on both engines.) |
| An engine hotfix changes `CompatibleChangelist` / BuildId | The prebuilt plugin no longer matches | Refuse by BuildId with a clear message. `latest.json` lists BuildIds per engine. Rebuild on hotfixes (checked each release). |
| AI-app config formats or paths change | Entries land in the wrong place | Writers are small and isolated. The doctor checks that entries resolve. Fixtures are pinned. The paths were checked on the build host at design time. |
| The MSIX Claude shadow-copy semantics differ from what we expect | The entry is not loaded | Prefer the existing shadow file. L8-style manual check on an MSIX install (OV-11). |
| Several server processes share the memory DB | `SQLITE_BUSY` | WAL mode and a 5 s busy timeout are part of G7, with a stress test as its acceptance criterion. |
| Install time dominated by file count (thousands of `node_modules` files and antivirus scanning) | Slow installs | Measure in L1. If needed, bundle the server into a few files later. Not in v1. |
| `irm \| iex` distrust or blocking (CLM, AMSI) | Some testers cannot use the one-liner | CLM is detected with guidance. Manual zip download + hash check is documented. The signed exe follows. |
| Corporate networks: authenticating proxies, PAC files, HTTPS inspection | Downloads fail | Every download goes through PowerShell with the Windows proxy and certificate store, and proxy credentials are passed (§6.1, §7.1). A certificate error has its own message and the manual `-PayloadPath` route. |
| AppLocker or WDAC blocks programs under `%TEMP%` and `%LOCALAPPDATA%` | `node.exe` can't start, even after a finished install | `install.ps1` maps error 1260 to code 9 with guidance; doctor has a `runtime.exec` check. |
| Long paths (deep `node_modules`, UE intermediate paths, projects under OneDrive) | Extraction or the plugin copy fails | Short temp and staging names; R8 caps payload paths at 140 characters; preflight skips a project that would pass 259 characters without long-path support. |
| Projects inside OneDrive | Sync locks during renames; cloud-only files downloaded by hashing | A warning, rename retries, and no hashing of cloud-only files (§6.5). |
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
| OV-5 | Signing: Azure Trusted Signing eligibility and prices; OV-on-cloud-HSM prices; whether EV still gives instant SmartScreen reputation | *(from memory, verify)* | Check the vendor pages and eligibility (early, with the maintainer's OK; §14), and decide before Phase 4 |
| OV-6 | Engine-folder (Advanced) installs need `.uproject` enable entries, and `EnabledByDefault` is not honoured for Marketplace-folder plugins | open (brief claim) | A load-test variant of L1 with `--plugin-location engine`, with and without the `.uproject` edit |
| OV-7 | The Fab requirements were read from a snapshot | *(unverified; out of v1)* | Re-read the live page before any Fab work (Q5) |
| OV-8 | Vercel serves `install.ps1` so that `irm` returns a string in Windows PowerShell 5.1 and PowerShell 7 | open | After the first deploy: `irm` in both shells. If needed, add a `vercel.json` header `Content-Type: text/plain; charset=utf-8` for `/install.ps1`. |
| OV-9 | The pinned Node zip's `node.exe` is signed `CN=OpenJS Foundation` | checked for the 24.14.0 MSI binary on the build host; open for the pinned zip | R5 asserts it on every build |
| OV-10 | `claude mcp add-json` behaviour when `hayba` already exists in user scope (error or overwrite) | open (the flags themselves are checked) | Run in a throwaway profile (`USERPROFILE` pointed at a temp folder); pin the remove-then-add path from the result |
| OV-11 | MSIX Claude Desktop reads `%APPDATA%\Claude\claude_desktop_config.json` when no shadow copy exists, and reads the shadow copy when it does | open | A manual check on an MSIX install: write, quit from the tray, restart, and confirm the server is listed. Test both states. |
| OV-12 | VS Code and Cursor pick up `mcp.json` changes without a restart | open | Manual check; adjust the "after" messages |
| OV-13 | Concurrent `DatabaseSync` access to one memory DB from several server processes | resolved by design: WAL and a busy timeout are part of G7 | G7's acceptance stress test |
| OV-14 | A server started by an AI client, with no editor running, answers MCP `initialize` promptly (the doctor's boot probe relies on it) | open | R6 smoke, and the first doctor run |
| OV-15 | `tar.exe -a -cf x.zip` output extracts correctly with `Expand-Archive` (5.1), `tar.exe`, and Inno | open | R8 round-trip test |
| OV-16 | Windows Defender / SmartScreen behaviour on the signed exe with the embedded `node.exe` | open | The pre-public clean-VM pass (§9.6) |
| OV-17 | A running Claude Desktop rewrites `claude_desktop_config.json` from memory and drops an entry written while it runs | *(unverified)* | Write the entry while the app runs, change a setting in the app, then check the file. If it is dropped, make the interactive quit prompt (§6.10.3) mandatory with `--yes` too. |

---

## Appendix A — Source facts this spec relies on

| Fact | Where |
|---|---|
| Plugin base dir = `IPluginManager::FindPlugin("HaybaMCPToolkit")->GetBaseDir()` | `HaybaMCPModule.cpp:146` |
| Node lookup: ThirdParty, then Program Files; no PATH or version check | `HaybaMCPModule.cpp:623-633` |
| Server lookup: override → dev → symlink-resolved dev (`GetFilenameOnDisk`) → ThirdParty; all `dist/index.js` | `HaybaMCPModule.cpp:635-678` |
| Sidecar started with no working directory and no pipes | `HaybaMCPModule.cpp:535` |
| `DASHBOARD_PORT` and `UE_TCP_PORT` set from settings; PLUMB stores pointed at `<Project>/.scratch` | `HaybaMCPModule.cpp:521-531` |
| Satellite check still lists Niagara and Sequencer; 8 s toast | `HaybaMCPModule.cpp:209-248` |
| Sidecar reuse is a TCP probe only | `HaybaMCPModule.cpp:266-281` |
| Editor TCP port walk 52342–52350; heartbeat at `Saved/HaybaMCP/instances/<pid>.json` | `HaybaMCPModule.cpp:432-468` |
| `SidecarURL` default `http://localhost:7821`; `bAutoStartSidecar`; `SidecarEntryPath` | `Private/HaybaMCPSettings.h:108-115`, `HaybaMCPSettings.cpp:286-287` |
| Toolkit `.cpp` count: 157 at `a5ceaa40` (147 at `dc6b4403`) | `git ls-tree` |
| Non-unity build; HTTP module already a dependency | `HaybaMCPToolkit.Build.cs:16`, `:41` |
| `.uplugin` dependencies; `Installed: false`; no `EngineVersion` pin | `HaybaMCPToolkit.uplugin:11,19-25`; `HaybaMCPGAS.uplugin:11,19-22`; `HaybaMCPMetaSound.uplugin:11,15-18` |
| `bootstrap.ts` installs redaction, then dynamically imports `index.js` | `mcp-tools/hayba-mcp/src/bootstrap.ts:8-11` |
| `resolveResource` candidates; `<pkg>/Resources` at candidate 2 | `config.ts:21-39` (`:29`) |
| Memory DB default in the package folder; opened without a busy timeout | `config.ts:84`; `gaea/memory/hayba-memory.ts:66` |
| Server writes under `%USERPROFILE%\.hayba\`; UE docs DB in the package folder | `conventions.ts:120`, `dag/index.ts:43`, `projects.ts:16`, `tools/asset-retriever/asset-indexer.ts:9`; `tools/docs/query-ue-docs.ts:76` |
| Code Mode is on unless `HAYBA_CODE_MODE=off` | `config.ts:74` |
| Client-started dashboard defaults to 52360; skipped on EADDRINUSE | `config.ts:51`; `dashboard/server.ts:96-104` |
| `/api/health` has no version; hardcoded `v1.0.0` log; server `package.json` version `1.0.0` vs `.uplugin` `0.3.0` | `dashboard/api.ts:39-49`; `index.ts:68`; `mcp-tools/hayba-mcp/package.json:3` |
| TCP `ping` already exists and is used for liveness | `tcp-client.ts:328`, `dashboard/api.ts:92` |
| Editor discovery: `UE_TCP_PORT` (always set by the plugin for its own sidecar, `HaybaMCPModule.cpp:523`), else the walk up from the working directory (8 levels), else 52342 | `tcp-client.ts:222-227` (walk at :149-217) |
| `engines: ">=22.5.0"`; unused dependencies | `mcp-tools/hayba-mcp/package.json:28,30,36,46-47`; root `package.json:11` |
| `node:sqlite` loaded at module scope | `gaea/memory/hayba-memory.ts:14` (+4 modules) |
| `@hayba/brain-protocol` is a workspace dependency; `prebuild:server` builds it | `mcp-tools/hayba-mcp/package.json:27`, `:15`; `packages/brain-protocol` |
| `HAYBA_BRAIN_URL` passthrough needed (the server reads it; no plugin code sets it); BYOK only in v1 | `config.ts:106` |
| Chat sessions cwd-relative | `chat/session-store.ts:90` |
| Visual sidecar default port 7822 | `addons/visual-embeddings/src/hayba_sidecar/server.py:97`, `tools/visual/sidecar-client.ts:1` |
| UE saves `.uproject` with `AutoDetect` encoding (UTF-16LE when not pure ANSI) | UE 5.8 `ProjectDescriptor.cpp:257`, `FileHelper.cpp:787` |
| GitHub release downloads redirect to `release-assets.githubusercontent.com` | `curl -sI` on a release asset, 2026-09-28 |
| Website is static, no build, git auto-deploy off | `vercel.json` |
| Release `v0.1.0` has no assets | `gh release view v0.1.0` |
| Launcher BuildId = `CompatibleChangelist` (5.7.4 → 47537391, 5.8.2 → 55116800); no `SourceDistribution.txt` | build host engines |
| `Marketplace` folder ACL `BUILTIN\Users:(I)(OI)(CI)(F)` | build host, UE 5.8 |
| Node `lstat` reports a junction as a symbolic link | build host, Node 24.14.0 |
| `code --add-mcp`, `cursor --add-mcp`, `claude mcp add-json … -s user`, `claude mcp remove … -s user` exist; `claude.exe` at `%USERPROFILE%\.local\bin` | build host, Claude Code 2.1.283 |
| `node.exe` signer `CN=OpenJS Foundation` | build host, 24.14.0 |
| `EditorSettings.ini` recent-project line format with `LastOpenTime` | build host, 5.8 |
