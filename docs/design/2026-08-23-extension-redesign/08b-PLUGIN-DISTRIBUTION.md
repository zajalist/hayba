# D1 revised — the plugin half of install

**Correction.** `08-EXECUTION-DISTRIBUTION.md` treated "install" as one
problem and solved the easy half. It is **two artifacts on two distribution
channels**, and npm only reaches one of them:

| Artifact | Goes where | Channel |
|---|---|---|
| `@hayba/mcp` (Node server) | the agent host's config | npm / `npx` |
| `HaybaMCPToolkit` (C++ editor plugin) | a UE project's `Plugins/`, or the engine | **not npm** |

`claude mcp add hayba -- npx -y @hayba/mcp` gets you a server that connects to
nothing, because the TCP peer on `:52342` lives inside the editor. Both halves
must land, and the plugin half is the harder one.

## Constraints, from the descriptor

`HaybaMCPToolkit.uplugin`: `"EngineVersion": "5.8.0"`, one **Editor** module at
`PostEngineInit`, `"Installed": false`, and five plugin dependencies (PCG,
PythonScriptPlugin, WebBrowserWidget, DataValidation, EnhancedInput). Because
it ships a compiled C++ module:

- Binaries are **per engine version and per platform**. One zip does not serve
  UE 5.7 and 5.8.
- Without binaries, the user needs Visual Studio and a project recompile —
  today's requirement, and the step that excludes Blueprint-only teams.
- `"EngineVersion": "5.8.0"` currently pins one version; the field's better
  citizens support a range (ChiR24 spans 5.0–5.8). Whatever range is
  genuinely supported must be *built and tested*, not merely declared.

## The three real channels

### A. Fab (Epic's marketplace) — the canonical answer
This is how a UE developer expects to get a plugin: find it, click install,
Epic hosts per-version binaries, it lands in the engine and is available to
every project. It also carries discovery value no GitHub release can.

Cost: a submission and review process, per-engine-version builds Epic
requires, and listing upkeep. It is the highest-value and slowest item on this
page — **start the paperwork early precisely because it is slow.**

### B. Prebuilt release zips — the near-term workhorse
`HaybaMCPToolkit-UE5.8-Win64.zip` attached to GitHub Releases, one per
supported engine version, built with precompiled binaries and
`"Installed": true` in the shipped descriptor. User unzips into
`<Project>/Plugins/` — no compiler, no project regeneration.

Requires a release build job (the repo has CI workflows to hang it off) and a
decision on the supported version matrix.

### C. An installer command — the glue that makes it one step
This is what closes the gap the user identified. Ship the installer *in the
npm package*, so the single command a user already runs can place the plugin:

```
npx @hayba/mcp install --project "D:/MyGame/MyGame.uproject"
```

What it does: detect the project's engine version from the `.uproject`,
download the matching prebuilt zip from GitHub Releases, unpack into
`<Project>/Plugins/HaybaMCPToolkit/`, enable the five plugin dependencies in
the `.uproject`, and print the one config line for the agent host (or write it
— that is D1.3's auto-configurator).

Notes:
- **Do not vendor the binaries inside the npm tarball.** Per-version DLLs
  would bloat every install; download on demand from Releases and cache.
- Add `npx @hayba/mcp doctor` — checks: plugin present and version-matched,
  the five dependencies enabled, editor reachable on `:52342`, server/plugin
  protocol versions agreeing. Most "it doesn't work" reports are one of those
  four, and today the user has no way to see which.
- Engine-wide install (into `<Engine>/Plugins/Marketplace/`) as an opt-in
  flag for people with several projects.

### Version-skew guard (new requirement this surfaces)
Two independently-installed artifacts *will* drift — an npm server auto-updated
by `npx` against a plugin installed months ago. The TCP handshake must
exchange versions and fail loudly with a legible message ("server 1.4 needs
plugin ≥1.3, found 0.3 — run `npx @hayba/mcp install --upgrade`"), rather than
failing as mysterious unknown-command errors. This did not exist as a
requirement while there was one hand-installed pair; it does now.

## Revised D1 order

1. **D1.2 prebuilt release zips** — the prerequisite for everything else here.
   Nothing can auto-install what does not exist as an artifact.
2. **D1.1 npm publish** — the server half.
3. **D1.6 `npx @hayba/mcp install` + `doctor`** *(new)* — makes the two halves
   one command. This is the item that actually answers the objection.
4. **D1.7 version-skew handshake** *(new)* — must land with, not after, the
   two-artifact split.
5. **D1.3 in-editor auto-configurator** — the reverse direction: user starts
   in the editor, plugin writes the agent host's config.
6. **D1.5 README** — rewritten around whichever of the above exist.
7. **D1.8 Fab listing** *(new)* — start early, lands late.

## Definition of done, restated honestly
A user with a `.uproject` and no C++ toolchain runs **one command**, then opens
their editor and their agent, and the two are talking — with a `doctor` that
names the exact failure when they are not.
