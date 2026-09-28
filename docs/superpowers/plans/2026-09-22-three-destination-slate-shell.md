# Three-Destination Slate Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace eleven implementation-named panels with Agent, World, and Library, supported by a unified icon/token system and contextual world findings.

**Architecture:** Build World and Library composites over existing models first, then atomically switch `EHaybaPanel` and navigation. Delete superseded panels only after parity tests pass; retain the web scene map and provide a textual fallback.

**Tech Stack:** Unreal Engine C++ editor module, Slate, WebBrowser/CEF, SVG resources, Unreal automation tests

**Spec:** `docs/superpowers/specs/2026-09-22-agent-workspace-world-tools-redesign.md`

## Global Constraints

- Navigation has exactly Agent, World, and Library; Settings is a bottom gear.
- The web scene map is canonical; the native `SCanvas` implementation is deleted.
- User-facing copy may not contain “Sliver,” “Tool Stream,” “Validation Report,” or “Memory Inspector.”
- Icons use a shared 24 px outline grid and inherit foreground color.
- Ochre `#C47A28` is limited to active, pending, unsaved, and actionable-violation states.
- Interactive targets are at least 32×32 logical pixels and icon-only controls require accessible text/tooltips.

---

### Task 1: Style tokens and four navigation icons

**Files:**
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPStyle.h`
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPStyle.cpp`
- Create/replace: `unreal/HaybaMCPToolkit/Resources/IconAgent.svg`
- Create/replace: `unreal/HaybaMCPToolkit/Resources/IconWorld.svg`
- Create/replace: `unreal/HaybaMCPToolkit/Resources/IconLibrary.svg`
- Replace: `unreal/HaybaMCPToolkit/Resources/IconSettings.svg`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Tests/HaybaMCPStyleTest.cpp`

**Interfaces:**
- Produces style keys `Hayba.Icon.Agent`, `.World`, `.Library`, `.Settings` and semantic colors `Hayba.Color.Active`, `.Pending`, `.Unsaved`, `.Violation`.

- [ ] Add a failing style test asserting all keys exist, SVG viewBoxes equal `0 0 24 24`, and icon files contain no baked `#FEE7C7` or `#C47A28`.
- [ ] Run the focused automation test and verify failure.
- [ ] Redraw the four glyphs with consistent outline weight, round caps/joins, and comparable optical bounds; register tokens centrally.
- [ ] Replace navigation consumers' raw color literals only where touched by this feature.
- [ ] Run style test and plugin build.
- [ ] Commit with `git commit -m "feat(ui): establish Hayba navigation visual system"`.

### Task 2: World composite and fallback

**Files:**
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPWorldPanel.h`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPWorldPanel.cpp`
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPSceneMapWebPanel.*`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Tests/HaybaMCPWorldPanelTest.cpp`

**Interfaces:**
- Produces: `SHaybaMCPWorldPanel` with map, selection inspector, landscape/partition summary, and contextual findings.
- Consumes: `world_inspect` result and existing web scene-map refresh hook.

- [ ] Add failing tests for WebBrowser-present and WebBrowser-absent construction, including visible textual world summary and setup action in fallback mode.
- [ ] Run focused automation test and verify failure.
- [ ] Implement map-first layout plus inspector drawer; render findings beside their resource references and directional repair actions.
- [ ] Ensure refresh preserves web view state and selected resource.
- [ ] Run focused tests and plugin build.
- [ ] Commit with `git commit -m "feat(ui): compose map and findings into World"`.

### Task 3: Library composite and Recipe vocabulary

**Files:**
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPLibraryPanel.h`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPLibraryPanel.cpp`
- Modify: files under `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slivers/`
- Modify: `mcp-tools/hayba-mcp/src/slivers/` and registration call sites
- Create: Library/Recipe vocabulary tests beside the affected TS and C++ modules.

**Interfaces:**
- Produces: `SHaybaMCPLibraryPanel` with searchable Assets, Profiles, and Recipes sections.
- Preserves old `hayba_sliver_*` tool names as one-release deprecated aliases with no user-facing label.

- [ ] Write failing TS alias tests and C++ copy tests that reject user-visible `Sliver` strings.
- [ ] Run focused tests and verify failure.
- [ ] Introduce Recipe-facing types/names, migrate display copy and widget class names, and retain narrow alias adapters at the tool boundary.
- [ ] Build Library over existing asset, memory/profile, and recipe sources with one search field and filter chips.
- [ ] Run tests, typecheck, plugin build, and `rg -n 'Sliver'` review; allow only compatibility/code-migration references.
- [ ] Commit with `git commit -m "feat(ui): merge reusable inputs into Library"`.

### Task 4: Atomic three-destination navigation switch

**Files:**
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPMainPanel.h`
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPMainPanel.cpp`
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPOnboardingWidget.cpp`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Tests/HaybaMCPNavigationTest.cpp`

**Interfaces:**
- Replaces `EHaybaPanel` with `Agent`, `World`, `Library`, and non-rail `Settings`.
- Consumes Agent from the activity plan and World/Library from Tasks 2–3.

- [ ] Add a failing navigation test asserting three rail destinations, Settings bottom placement, exact label/icon-key equality, 32 px targets, and default Agent content.
- [ ] Run focused automation test and verify failure.
- [ ] Replace enum, sidebar order, labels, icon keys, caches, and refresh hooks atomically; update deep links from chat footer and onboarding.
- [ ] Ensure compact mode provides tooltips and accessible names for every icon.
- [ ] Run navigation/UI tests and plugin build.
- [ ] Commit with `git commit -m "feat(ui): switch Hayba to three destinations"`.

### Task 5: Delete superseded panels and native scene map

**Files:**
- Delete: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPSceneMapPanel.*`
- Delete after parity: standalone Plan, Diff, Tool Stream, Validation, Lessons, MCP capabilities, and Memory panel files
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/HaybaMCPToolkit.Build.cs`
- Modify: affected includes/registrations in `HaybaMCPModule.cpp` and main panel files

**Interfaces:**
- Consumes: parity established by prior tasks.
- Produces: one implementation per product concern and no legacy panel registrations.

- [ ] Add a repository contract test/script that fails if deleted panel headers are included, classes are constructed, or old enum values remain.
- [ ] Run it and confirm it fails before deletion.
- [ ] Delete superseded files, registrations, style keys, refresh hooks, and build dependencies used only by the native scene map.
- [ ] Run plugin build and all UI automation tests.
- [ ] Commit with `git commit -m "refactor(ui): remove superseded Hayba panels"`.

### Task 6: Copy, accessibility, and full-story verification

**Files:**
- Modify: `docs/wiki/UE-Plugin.md`
- Modify: `docs/wiki/Getting-Started.md`
- Modify: `unreal/HaybaMCPToolkit/README.md`
- Modify: `CHANGELOG.md`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Tests/HaybaMCPWorkspaceStoryTest.cpp`

**Interfaces:**
- Verifies the public product vocabulary and end-to-end navigation story.

- [ ] Add an automation story: open Agent, render an awaiting-approval activity, approve it, open its World resource, then expose Save as Recipe in Library.
- [ ] Add keyboard checks for rail navigation, activity expansion, approval, cancellation, and focus preservation during a stream update.
- [ ] Run the story and correct any failures.
- [ ] Run `rg -n -i 'Sliver|Tool Stream|Validation Report|Memory Inspector|EHaybaPanel::(Chat|MCP|Plan|Diff|Validation|Memory|Lessons)' unreal/HaybaMCPToolkit docs/wiki`; expected matches are migration history only.
- [ ] Update documentation and screenshots/copy to Agent, World, Library, and Settings.
- [ ] Run full plugin build, Unreal automation suite, MCP tests/typecheck, and `git diff --check`.
- [ ] Commit with `git commit -m "docs(ui): publish the simplified in-editor workspace"`.
