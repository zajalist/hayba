# Hayba Master Plan — 2026-08-23

One plan that supersedes and absorbs: `02-PLAN.md` (redesign workstreams
W0–W8), the live remainder of `docs/plans/2026-06-28-mcp-supertooling-roadmap.md`
(its Phase 0/1 gates are DONE — freezes fixed, SEH at the dispatch seam,
descriptor/pyTemplate factory, honest count ~195), ADR-0009, and the three
2026-08-23 reviews (`00b-FIELD-DEEP-DIVE`, `01b-ARCH-REVIEW-CPP`,
`01c-ARCH-REVIEW-TS`).

Decisions already locked (see 02-PLAN §"decisions"): A+B positioning under the
one-understood-world spine; Profile/Rule/Recipe collapse with deletions;
five nouns; captured-plus-seeded Recipes with wizard seeding; session-scoped
redaction-aware capture buffer; cool chrome + semantic ochre; read-only
source access for the in-editor agent (no write authority).

---

## The strategic picture, updated by the research

1. **Aura's headline is unbacked.** "Recovers from editor crashes" and "playtests
   itself" appear nowhere in their documentation; their C++ docs tell users to
   close the editor and rebuild by hand. We have the machinery they claim
   (SEH-at-dispatch, async job registry, transactional undo, hash-only
   journal). **The gap is evidence, not capability.** Nobody in this field
   documents reliability; the first credible reliability page owns the word.
2. **Epic commoditized the socket** (5.8 experimental `UnrealMCP`,
   `UToolsetDefinition` extension point). Generic editor verbs are now a
   first-party feature. Value lives above the verbs: world model, rules,
   trustworthy edits — and in interop (speak their Toolset meta-verbs).
3. **The MCP 2026-07-28 spec is the unexploited lever.** Tasks / cancellation /
   elicitation / sampling map ~1:1 onto our job registry, Plan Mode, and BYOK
   — and no competitor uses them. Issue #381 (SDK v2) is a differentiator
   vehicle, not plumbing.
4. **Both codebases have the same disease in different tissue**: a strong
   centre (router/transport/executor/redaction) surrounded by an under-adopted
   periphery. C++: 478 raw param reads vs an unused shared reader, 6/33
   domains on the Ops pattern. TS: 180 hand-rolled envelopes vs 9 canonical,
   90 double-declared schemas, 8 paths to UE. The refactors are mostly
   *adoption* of already-designed seams, not invention.
5. **Watch IvanMurzak** (Unity-MCP author porting one-attribute tool
   registration + skills autogen to UE). Steal from CoplayDev Unity-MCP (the
   in-editor client auto-configurator) and remiphilippe (offline UE doc
   search).
6. **Token economy is TABLE STAKES, not a moat** [11-CAPABILITY-MATRIX].
   StraySpark ships catalog mode (62K→3K tokens); Monolith ships namespace
   dispatch; ChiR24 ships fat tools. **This retires Moat 3 of the supertooling
   roadmap.** Code Mode is competitive, not differentiating — stop leading
   with it.
7. **"Wrap Epic, then extend" is the winning pattern** [11]. UAIP already
   ships 190 bridges into Epic's Toolset plus 540 native commands, and Epic's
   **MCP Client Toolset (Beta)** is the sanctioned path for a third-party
   server to be consumed by Epic's agent UI. Epic ships ~700–830 tools,
   **~40% Animation/Sequencer**. Breadth is lost; composition is cheap.
   **E1 is elevated from nice-to-have to strategic imperative.**
8. **Six competitors were missing from the first roster** [11]: Monolith
   (~1,400 actions, **MIT and free**, "Reflection Intelligence" reading engine
   C++), StraySpark (409 tools, **universal named undo per mutation**, scoped
   auth tokens — genuinely ahead of us on both), UAIP, Ultimate Engine CoPilot
   (1,050+, voice, concurrent agents), Ludus, CodeFizz.
9. **Our own asset pipeline is broken in three places** [10-ASSET-PIPELINE-
   GROUND-TRUTH]: connector import is hard-gated shut, the native importer
   rejects the formats the connectors deliver, and the shipped agent prompt
   calls three tools that do not exist. See Track A.

---

## Track structure

Seven tracks. R (reliability/evidence) and F (foundations) run first and in
parallel; P (product redesign) waits for the crash P0s; D (distribution) is
independent of all of them and can start today; A (assets/environments)
carries the product's stated purpose and has the worst holes; G (growth) and E (ecosystem)
trail. Every item carries its source.

### Track R — Reliability, finished and *provable*
*The moat is real; make it visible and total.*

- **R1. Land the open crash-resilience P0s** — #406, #407, #411, #415, #387,
  epic #373. Unchanged; still gates Track P's Slate work. [02-PLAN W8]
- **R2. Kill the last game-thread blockers** [01b §2]:
  - RenderHandler's `Sleep()` poll loop (`HaybaMCPRenderHandler.cpp:280`) →
    ticker-predicate + the existing `FLease` stages. The worst single offender
    left.
  - `GetAllAssets` → cached, invalidated, filtered registry access
    (= 02-PLAN W1a, the live "catalogue slow" complaint).
  - Instrument the 67 `LoadObject` + 18 `SavePackage` game-thread sites
    (`HaybaAssetAccess::Load` duration advisory); make `MaxCommandsPerTick`
    time-budgeted.
  - `PlanModeToolCallCount++; S.Save()` per command → debounce.
- **R3. Close the bypasses** [01b §4, 01c §2]:
  - The 4 inline router commands bypass Plan Mode/SEH/journal → move into a
    `FHaybaMCPUIBridgeHandler` behind one `OnCommandCompleted` multicast;
    `hayba_propose_plan` stays the sole documented exception.
  - `dashboard/api.ts` raw sends → `executeCommand`; widen the WORKFLOW
    Step-4 lint to all of `src/` with an allowlist.
  - `isToolDisabled` honoured on every registration path (one
    `registerName()` helper).
- **R4. The evidence play** (new; from 00b): a public **Reliability** doc —
  crash-class inventory, what is guarded where (SEH seam, job registry,
  transactions, redaction boundaries), and a reproducible torture-test suite
  (the editor-survival script already exists:
  `scripts/test-editor-survival.ps1`). This converts Moat 1 from code into
  positioning. No competitor names in it (per policy); capabilities on their
  own terms.
- **R5. MCP SDK v2 / spec 2026-07-28 migration (#381), scoped as
  differentiators**: job registry → protocol Tasks (survives socket loss —
  the crash-reconnect story in protocol grammar); cancellation → FSlowTask;
  elicitation → protocol-level Plan Mode; sampling → build-log/screenshot
  judgment under BYOK.

### Track F — Foundations: adopt your own seams
*Almost every item is "finish a pattern that already won."*

TS side [01c ranked list, endorsed]:
- **F1.** Collapse the 90 schema double-declarations (`defineTool`, per-domain
  descriptor barrels); split `tools/index.ts` (3,873 L) accordingly. Add-a-tool
  drops from 4–9 touches toward 2 (wrapper + sidecar). Diff
  `get_tool_signature` output before/after.
- **F2.** One envelope module (`ok`/`err`/`rich`); migrate 180 inline
  envelopes byte-identically; delete the contradictory "do not adopt" note;
  lint in `scripts/`.
- **F3.** One `ToolDispatcher` behind `hayba_invoke` + chat (pin the
  plan-mode-pause unwrap difference with a test first); decompose
  `registerDeferredRouting` into pure builders.
- **F4.** Descriptor-driven `retry`/`blocksGameThread` meta (kills the
  127-name mutable Set + 10 domain arrays) — gated on **F5**.
- **F5.** Branded `WireCommand` type validated against sidecar keys — the
  compiler replaces the grep (and ADR-0007 gets a type-level ally).
- **F6.** Contract tests → `scripts/contracts/` drift lints; keep every
  lesson, stop breaking on correct refactors. 50 readFileSync test files
  audited in the same pass.
- **F7.** **LANDED 2026-08-24** (`tools/capability-inventory.mjs`, 236 commands /
  34 handlers, CI-gated). W0 from 02-PLAN, sharpened by the reviews: generate `sidecar.json`
  and `CAPABILITIES.md` from `GetCommands()` at build; CI gate on drift
  (82 implemented-but-undescribed commands today); fix `.codex/config.toml`
  geoforge paths.
- **F8.** W1b: precompute the `searchNodes` haystack. **LANDED 2026-08-24** —
  measured **6.5×** (7.740ms → 1.186ms per query), not the 10–50× estimated
  here. See `STATUS.md`.

C++ side [01b ranked list, endorsed]:
- **F9.** `FHaybaParamReader` becomes the only door (delete the decoy thin
  wrappers; migrate UIHandler/PIEHandler/LegacyHandler/AssetHandler first =
  275/478 sites).
- **F10.** `HaybaSceneQuery` — one actor/world lookup with uniform ref
  semantics; label collisions become errors (currently silent first-match —
  a correctness bug, not just cleanliness).
- **F11.** `HaybaMutation::SaveAsset` — dirty + save + verify + canonical
  message; 44 stray `MarkPackageDirty` and 18 unverified saves converge.
- **F12.** Deferred-completion case on `IHaybaMCPHandler` (`Ok/Err/Deferred`)
  — the missing interface case behind three divergent workarounds; the TCP
  reservation machinery already supports it. First cut: Deferred ⇒ no editor
  transaction; job registry remains for long mutations. Feeds R5's Tasks.
- **F13.** Ops-pattern completion for the two whales (UIHandler 4018,
  PIEHandler 3259 → target ≤800/handler), continuing #320.
- **F14.** *(Smaller than described: the orphaned dirs are untracked local build
  residue, not repo content — an `rm`, not a commit.)* Unify handler registration (core list → `RegisterExternalHandler`)
  and delete the orphaned `HaybaMCPNiagara/`/`HaybaMCPSequencer/` binary
  dirs. **Best value-per-effort in either codebase.**

### Track P — Product: the five-noun redesign
*Unchanged from 02-PLAN W2–W6 + ADR-0009, with review-sourced additions. Slate
work still gates on R1.*

- **P1.** W2 collapse — now with the exact inventory: unify the **5 finding
  shapes** [01c §3e] into the PLUMB directional verdict; delete
  `ValidatorFinding` + the 4 dead rules + their pinning test; rename slivers →
  Recipes; Recipes emit verdicts (the triggering moment).
- **P2.** W3 IA rewrite (5 nouns. **Scene Map renderer: decision withdrawn —
  see `15-SCENEMAP-CORRECTION.md`.** The two renderers are a shipped
  Web/Native/Auto user setting, not duplication, and only the native one
  receives the router's `scene_get_graph` push, so the default Auto→Web path
  already drops it),
  **plus** [01b §3]: extract `FHaybaChatModel`/`FHaybaToolStreamModel` as
  module-owned plain structs (the Studio/Slivers pattern) — this is also the
  prerequisite for chat persistence; replace singleton reach-through with the
  `OnCommandCompleted` delegate from R3.
- **P3.** W4 visual system — tokens land in `FHaybaMCPStyle` and sweep the
  **47 inline FLinearColor literals** [01b §3]; 13 icons + 3 shared state
  marks (assets done, v2); ochre-semantics rule into CONTRIBUTING.
- **P4.** W5 Recipes-become-real (prove/kill pcg_biome; capture ring buffer;
  review sheet; Save-as-Recipe; ~6 wizard-seeded presets).
- **P5.** W6 first-run — plus the stolen pattern [00b §4]: an in-editor
  **client auto-configurator** (detect Claude Code / Cursor / VS Code /
  Claude Desktop and write their MCP config), replacing the hand-edit-JSON
  step. Unity-MCP proved this kills the top onboarding failure.
- **P6.** W7 code loop under the no-write decision:
  `livecoding_compile_await` + UBT diagnostics parser + read-only source
  tools + propose-patch UI; chat persistence (via P2's model extraction).
  Add [00b §1]: **offline UE API doc search as a tool** (remiphilippe's
  Bleve pattern; our `docs/ue-header-index.ts` is the seed) — kills the
  guess-wrong-API bug class and was already roadmap item "reflection
  intelligence".

### Track D — Distribution: install friction and repo hygiene
*The repo is the front door. Today it is a workshop.* Full plan in
`08-EXECUTION-DISTRIBUTION.md`.

- **D1. Install friction.** Today: copy the plugin, regenerate VS project
  files, **recompile**, then hand-edit client JSON with an absolute path to a
  `dist/` that is not committed. Five steps, each a drop-off, and step 3
  excludes Blueprint-only teams with no VS toolchain.
  - **Install is TWO artifacts, not one** (see `08b-PLUGIN-DISTRIBUTION.md`):
    the npm server reaches the agent host; the compiled UE editor plugin must
    still reach a `Plugins/` folder. npm alone yields a server connected to
    nothing.
  - **D1.2 Prebuilt plugin release zips per engine version** — the
    prerequisite for everything else; nothing can auto-install a
    non-existent artifact. (`v0.1.0` exists with no binaries attached.)
  - **D1.1 Publish `@hayba/mcp` to npm** — `package.json` already declares
    name, version and `bin`.
  - **D1.6 `npx @hayba/mcp install --project <x.uproject>` + `doctor`** —
    detects engine version, fetches the matching zip, unpacks into
    `Plugins/`, enables the five plugin dependencies. `doctor` checks the four
    things that break (plugin present / deps enabled / editor on :52342 /
    version match). **This is the item that makes install one step.**
  - **D1.7 Version-skew handshake** — two independently-updated artifacts will
    drift; the TCP handshake must fail with a legible upgrade instruction, not
    unknown-command errors.
  - **D1.8 Fab listing** — the canonical UE channel and the discovery win;
    slow, so start the paperwork early.
  - **D1.3 In-editor client auto-configurator** (= P5) — detect Claude Code /
    Cursor / VS Code / Claude Desktop and write their MCP config. The
    best-proven onboarding fix in the field.
  - **D1.4 First-run honesty** (= W6). **D1.5 README: a 60-second path**, with
    source-building moved below the fold.
  - *Not doing:* a plugin-free fallback. The Node server owns the validator,
    recipes, routing and world model; a thin mode would be a different product.
- **D2. Repo hygiene.** Verified: `Binaries/`/`Intermediate/` are correctly
  gitignored (0 tracked), `dist/` is not committed, only one tracked binary
  (shipped data). But the pack is **2.32 GiB**, and `website/assets/` is
  **53 MB across 46 files** (a 5.6 MB PNG, several 3 MB JPEGs).
  - **Measure before rewriting.** `gc --prune=now` and a largest-blobs report
    first — last time this looked catastrophic it was unreachable garbage, not
    history. `filter-repo` only on evidence and an explicit decision; it
    breaks every clone and this repo owns tags that must survive.
  - Compress the website assets for their own sake (the site deploys from
    here).
  - Front door: README should open with **what this is and a picture**, then
    one install line. Publish and link `CAPABILITIES.md` (F7) and
    `RELIABILITY.md` (R4) — no competitor ships either.

### Track A — Assets & Environments
*The product's stated purpose has a broken supply chain. Full ground truth in
`10-ASSET-PIPELINE-GROUND-TRUTH.md`; competitor read in `09-NWIRO-DEEP-DIVE.md`.*

- **A0. Stop advertising what does not exist.** `hayba_generate_moodboard`,
  `hayba_fetch_references`, `hayba_compare_clip_score` are called by the
  shipped agent prompt (`hayba.agents.json:8`) and the `hayba-new-scene`
  skill, and are implemented nowhere; `level_get_spatial_index` is a deferred
  stub. Either implement or delete from the prompt and skill. **Same honesty
  rule as the dead validator rules — and this one is in the system prompt.**
- **A1. Unblock asset import** — the two-part fix:
  - `importIntoUe()` always returns `ok:false`, gated on #415
    (`asset-sources/shared.ts:399-420`). Landing #415 is the unlock.
  - **Widen the format matrix.** Native `asset_import` accepts only
    png/jpeg, wav, binary FBX (`HaybaMCPAssetHandler.cpp:784`) while the
    connectors deliver **glTF/GLB/HDR/EXR**. Fixing #415 alone changes
    nothing. Both must land together or the pipeline stays dead.
- **A2. Assemble materials from imported map sets.** No
  `material_from_textures` exists, so an ambientCG/PolyHaven texture set
  would import as loose textures. Cheap, and it is what makes texture
  acquisition actually useful.
- **A3. Use the CLIP we already run.** The sidecar serves CLIP/SpatialCLIP/
  OWL-ViT but asset selection uses text-only BM25/Ollama. CLIP-based
  intent↔asset matching is the difference between our retrieval and Nwiro's
  **filename-string matching** — and it is sitting unused.
- **A4. Fix `world_generate`'s honesty and depth.** Today: 4 hardcoded layers,
  first-search-hit mesh, **flat z with no terrain raycast**, and only the
  `grounded` primitive despite the header claiming "non-interpenetrating".
  Terrain conform + a real clearance/interpenetration constraint are the
  minimum for the claim it already makes.
- **A5. 3D generation — decide the posture.** Zero integration today (not even
  a stub). Licensing constrains the choice: Hunyuan excludes EU/UK/South Korea
  and bars training on outputs; Tripo and Meshy paywall commercial rights
  (Meshy free tier = CC BY 4.0 with Meshy owning the IP); **TRELLIS.2 (MIT)
  and Sloyd (procedural) are the only clean commercial options**. Async
  `create → poll → import` with mesh normalization (scale/pivot/up-axis) is
  the shape; **import hygiene — LOD, collision, UVs, Nanite prep — is the part
  Nwiro appears not to do and the part that decides whether output is usable.**
- **A6. Revive or delete the Gaea terrain pipeline.** `src/gaea/terrain-
  pipeline.ts` is a complete biome/mood/geology intent analyzer with a layout
  engine and archetype store, imported by nothing. It is the largest instance
  of the slivers disease in the repo. Either wire it to terrain generation or
  delete it.
- **A7. Interiors — the field's admitted gap.** Nwiro users report it cannot
  produce coherent buildings or interior layouts, and a name-matched scatter
  structurally cannot. Our PLUMB room-grammar / junction / productions
  machinery targets exactly this and is unwired to any workflow.

### Track G — Growth (from the supertooling roadmap, resequenced)
*The roadmap's Waves continue, but behind F1's cheaper add-a-tool gate.*

- **G1.** Wave 4 domains for demo-ability (Sequencer/Niagara/Water) — after
  F1 so they land as barrels, not index.ts additions.
- **G2.** The roadmap's ranked not-yet-built items that survived review:
  pcg_reset/regenerate; world_generate download-to-fill; PIE/runtime depth;
  universal dry_run. (Reflection intelligence moved into P6; SEH extension
  is R1/R2 territory.)
- **G3.** The packaging/demo-reel pivot the roadmap already recommends over
  grinding to 400 tools — sequenced after P3 so the reel shows the new UI.

### Track E — Ecosystem / interop
- **E1.** Speak Epic's Toolset meta-verbs for 5.8 interop [roadmap §2].
- **E2.** Evaluate a no-Node native transport option (ChiR24 pattern) as an
  install-friction experiment — *evaluate*, not commit; the Node server owns
  too much (validator, recipes, routing) for a full no-bridge parity.
- **E3.** Fab listing groundwork once P5's onboarding is real.

---

## Sequencing

```
now ──────────────────────────────────────────────────────────▶
R1 crash P0s ══════════╗
F7/F8/F1..F6 (TS-only) ═╬═══════╗          (safe alongside R1)
F14, F9..F11 (C++ small)╚═══════╬═════╗    (small, reviewable C++ PRs)
                        R2, R3  ╚═════╬════╗
                        P1 (TS collapse)   ╠══════╗
        R1 done → P2/P3 (Slate rewrite) ═══╣      ║
                        F12/F13 ═══════════╝      ║
                        P4/P5/P6 ═════════════════╬═════╗
                        R4 evidence page ═════════╣     ║
                        R5/#381 SDK v2 ═══════════╝     ║
                        G1..G3, E1..E3 ═════════════════╝
```

Rules of the road:
- No Slate rewrite (P2/P3) until R1 lands — same files, six critical issues.
- No new tool wave (G1) until F1 lands — otherwise 30 more index.ts entries.
- F4 waits for F5 (namespace first, then metadata).
- Every deletion in P1 goes through F7's generated inventory first.

## The "finished" test (unchanged, now enforced by structure)

A feature is finished when: it has a triggering moment; it tells the truth;
it has one name; it has a verdict; it is reversible (or says it isn't).
Track F makes several of these structural: F7 makes truth-telling generated,
F2 makes verdict shape singular, P1 makes the verdict directional everywhere.

## What this plan deliberately does not do

- Chase tool-count parity (the field study shows it buys nothing).
- Add validator rules before the collapse (the honest short list is the
  feature).
- Give the in-editor agent write authority (decided; revisit only after R4's
  evidence page exists and P6 ships).
- Build in-engine 3D asset generation (structural gap, not a plugin feature;
  world_generate download-to-fill in G2 is the answer we can own).
- Collapse the three redaction boundaries "for cleanliness" — they cover
  different exits [01b, load-bearing list].

---

## Execution plans (2026-08-23, post-review)

The tracks above are the strategy. These are the commit-level plans:

| Doc | Covers | Safe beside crash branch? |
|---|---|---|
| `04-EXECUTION-P3A-visual-layer.md` | P3a — icons + tokens + row state, **look only, no IA change** | **Yes** — no crash issue touches `HaybaMCPStyle.cpp` |
| `05-EXECUTION-FOUNDATIONS.md` | F14 / F8 / F7 | Yes — none touch CommandHandler, handlers, or panels |
| `06-EXECUTION-P1-collapse.md` | P1 — ADR-0009, five verdict types to one | Yes — TypeScript only |
| `07-RELIABILITY-EVIDENCE.md` | R4 — the evidence play | Yes — writing, not code |
| `08-EXECUTION-DISTRIBUTION.md` | D1 / D2 — install friction, repo hygiene | Yes — packaging and docs |
| `STATUS.md` | **What is actually built** vs what these plans intend | read first |
| `09-NWIRO-DEEP-DIVE.md` | The closest competitor: name-matcher world gen, no validation, library moat | research |
| `10-ASSET-PIPELINE-GROUND-TRUTH.md` | Track A — what our asset/world pipeline actually does | research |
| `11-CAPABILITY-MATRIX.md` | Whole-field feature audit, whitespace vs table stakes | research |
| `08b-PLUGIN-DISTRIBUTION.md` | D1 revised — the **plugin** half: release zips, `npx … install`, doctor, version skew, Fab | Yes — packaging |

### Revision to the phase gate
The original gate ("no Slate work until R1") was too broad. The collision risk
is `HaybaMCPCommandHandler.cpp` and the panel files — **not the style set**.
Split accordingly:

- **P3a (visual layer)** — start now. Lands the design language on the
  existing 11 tabs and answers the only open question the review canvas
  cannot: do the icons hold at 28px in real Slate chrome.
- **P3b (IA rewrite — `EHaybaPanel`, MainPanel, panel deletions)** — still
  gated on R1. Unchanged.

### Recommended start order
1. **P3a** + the 2× PNG pipeline (see 04) — fastest path to seeing it real.
2. **F14 / F8 / F7** in parallel (see 05) — structural debt, no interdependency.
3. **P1** once F7's inventory exists (see 06).
4. **D1.2 → D1.1 → D1.6** (see 08b) — release zips, then npm, then the
   installer that unites them. Independent of every other track.
5. **R4** after R2 closes the render-handler hole (see 07).


---

## Track A progress — 2026-08-25

**A0 — stop advertising what does not exist. DONE (`56c9c5d5`).**

Verified the claim rather than trusting the earlier audit: `hayba_generate_moodboard`,
`hayba_fetch_references` and `hayba_compare_clip_score` have zero implementations
anywhere — not in C++, not in TS, not in the sidecar. The agent system prompt
instructed every model to "always call" two of them at the start of a new scene
task, so every such task opened with a failed call, and the executor prompt named
the third as the way to verify success.

Implementing them is A3 and is not a text edit. The prompts and both workflow
skills now name only tools verified to exist, and state visual intent in words up
front so the captured viewport has something to be judged against. Weaker than a
CLIP score, and honest.

`tools/prompt-tool-check.mjs` is the gate, in CI beside the capability and icon
checks. It cross-checks every backticked tool name in `hayba.agents.json` and the
workflow skills against commands declared in C++, described in `sidecar.json`, or
registered in TS. Confirmed it catches an invented name rather than assuming so.
It correctly does NOT flag `level_get_spatial_index`, which exists as a stub.

**A6 — revive or delete the terrain pipeline. DELETED (`3d9f918a`).**

`terrain-pipeline.ts` plans a positioned terrain node graph and nothing imported
it but its own test; `layout-engine.ts` existed only for it, and
`knowledge/archetype-store.ts` says in its own header it is "retained here so
terrain-pipeline.ts compiles". ~700 lines plus a knowledge base, closed island.

Deleted rather than wired, because wiring is not small and not the direction: it
authors graphs for an external node-graph terrain tool, while this product
consumes built heightmaps and has no graph executor. Its analyzer is also not a
drop-in for `world_generate`, which already extracts exact nouns ("hemlock"
searches hemlock) rather than resolving to a biome label. One revert away if a
graph executor ever lands.

The directory was doing three unrelated jobs. The live parts — the SQLite memory
store behind the memory tools, and the SessionManager type stub — moved to
`src/memory/`. What stays is research material, which is what the directory is
honestly named for.

### Flagged, not decided

`src/gaea/transcripts/` holds 66 scraped third-party tutorial transcripts, 1.1 MB,
referenced by no code. Given the standing rule about never framing this work as
derived from that tool, a corpus of its tutorial transcripts sitting in the repo
is worth a deliberate decision — keep as private research, move out of the repo,
or delete. Not a call to make unilaterally, so it stands.

### Next in Track A

A1 (import unblock + format matrix) is the biggest unlock but needs #415 and the
native format widening together, and the C++ half means a plugin rebuild. A2
(`material_from_textures`) is the cheap win that makes texture acquisition useful.


---

## A1 correction — the blockage is gone, and the audit had gone stale (2026-08-25)

A1 said asset import was dead in two ways. Both are false against the current
tree, and I checked before building a fix for a problem that no longer exists.

**"`importIntoUe()` always returns `ok:false`, gated on #415."** It does not.
`asset-sources/shared.ts:68` is a full implementation: it walks the extracted
directory, builds one `AssetImportTask` per file, runs them through
`python_run`, and returns `ok:false` only when the script genuinely fails.

*(Correction, 2026-08-25: an earlier revision said "#415 landed on this branch
as 3b2d102e". It did not — that commit is on
`feat/crash-resilience-advisory-hardening` and is NOT an ancestor of this
branch. The conclusion is unaffected, because it rests on reading the code in
this worktree and on importing a glTF and an HDR through a build OF this
branch, not on the commit's provenance. But the attribution was wrong.)*

**"Native `asset_import` accepts only png/jpeg, wav, binary FBX
(`HaybaMCPAssetHandler.cpp:784`)."** There is no format whitelist anywhere in
the plugin. `AssetImport` hands the file to `ImportAssetsAutomated` and lets
UE pick a factory by extension. Line 784 is now `asset_move` — the file was
rewritten by #415, so the citation no longer points at what it described.

**Verified against the live editor rather than by reading.** A hand-authored
minimal glTF 2.0 (one triangle, embedded buffer) and a hand-authored Radiance
`.hdr` were imported through `asset_import`:

    probe_triangle.gltf -> StaticMesh
    probe_sky.hdr       -> TextureCube

Both are the correct asset types — UE recognised the HDR as a cubemap, which
is what an IBL/sky source should become. Neither was written to disk, and the
probe assets were removed.

So the connector pipeline's import step is not blocked, and the format matrix
does not need widening. **A1 is closed.**

### What this says about the audit

Two of A1's three claims were precise, file-and-line specific, and wrong,
because the tree moved under them. The same was true of A0's `level_get_
spatial_index` note and of A6's line references. The audit documents are worth
keeping as a record of reasoning, but every item should be re-verified against
the tree before work starts, not treated as a work order.

### What is actually left in Track A

- **A3** — CLIP-based intent-to-asset matching. The sidecar already serves
  CLIP; asset selection still uses text-only BM25/Ollama. This is also what
  would let the three deleted prompt tools come back honestly.
- **A4** — `world_generate` terrain conform. Still real: flat z, no raycast.
- **A5** — 3D generation posture. Unstarted; a licensing decision first.
- **A7** — interiors via the PLUMB room grammar. Unwired.

End-to-end proof of the connector path still wants one real download through
ambientCG, which hits an external API and writes to the project — worth doing
deliberately rather than as a side effect of a check.


---

## Track A status — 2026-08-25 (later)

**A2 — material_from_textures. DONE (`7831592d`).** An imported texture set
becomes a wired PBR material. Classification is pure and covered from real
ambientCG and PolyHaven filenames. Two bugs found by probing a live editor
before trusting the mocks: `material_add_node` wants `SamplerType` in
PascalCase (the `sampler_type` first sent is accepted, ignored, and reported
only in `unknown_props`), and that call returns `ok:true` even when a property
matched nothing — so an unapplied property is now an error here.

**A4 — terrain conform. DONE (`f78ee83c`, `fd5fcdba`).** Instances are traced
onto the actual ground instead of sharing the area actor's z. Adding the
clearance constraint exposed that the conform was self-defeating: `grounded`
measures against the world plane z=0, so on a hillside it failed every instance
and dragged them back down, undoing the trace. It now runs only on the
unconformed fallback. The trace returns a surface while a placement is a pivot,
so the conform offsets by `ground_offset_m` — the SM_GiantTree lesson, enforced
rather than remembered. Same-asset clearance runs before the trace, because a
clearance fix pushes in XY. The description stops claiming
"non-interpenetrating" and states what is and is not proven.

Every line of the trace script was wrong on the first attempt and corrected
against a live editor: `EditorSubsystemLibrary` does not exist, a `HitResult`
has no `.impact_point` attribute, `get_editor_property('impact_point')` raises,
and `location` sits a trace-epsilon above the surface. Verified end to end on
two platforms at different heights — a flat test scene would have let a broken
implementation look right.

**A3 — CLIP asset matching. DONE (`66d38402`, `e7411853`, `3a00e68e`).**
`_Clip` had held a tokenizer since it was written and nothing ever called it,
so the sidecar could say what a thumbnail looked like but never which thumbnail
matched a phrase. `/embed_text` uses the tokenizer that was already there;
`rankAssetsByIntent` scores candidates; `asset_find_by_look` exposes it.

Not scored zero, reported unscored: an asset with no thumbnail was not looked
at, and a zero would sort it among the poor matches as though it had been. A
missing sidecar returns `ok:false` rather than an empty ranking, because "no
asset looks like that" is a claim you cannot make without looking.

**Not verified:** none of A3 has run against real CLIP weights. Whether the
sidecar is installed on this machine is unknown, and the tests deliberately use
stand-ins. First real use should confirm the scores are meaningful and not just
well-shaped.

### Remaining in Track A

- **A5** — 3D generation posture. Needs a licensing decision first: TRELLIS.2
  (MIT) and Sloyd are the clean commercial options.
- **A7** — interiors via the PLUMB room grammar, still unwired.
- Cross-asset interpenetration in `world_generate` — needs real overlap, not a
  centre-distance proxy.


---

## A7 — interiors: what is actually there (2026-08-25)

A7 said the room-grammar machinery "is unwired to any workflow". Checked, and
the shape of the gap is different from that.

**The tool exists and is registered.** `plumb_grammar_expand` has been in the
catalogue the whole time.

**It shipped with no grammar.** The production store starts empty, so it
answered every seed with an empty plan and "call plumb_production_define to
author rules" — asking someone to write a grammar before they have seen one
work. A starter set existed as a TEST FIXTURE: five productions, tunnels,
shafts and rooms in two builder styles. It now ships and is seeded on first
run (`17474b92`), and the tests read the same file so what ships is proven.

**What a seed actually produces**, run against the shipped grammar:

    room / imperial   3 items   shell(room) + scatter(debris) + fill(floor_detail)
    room / native     2 items   shell(room) + scatter(rubble)
    tunnel / native   7 items   shell + columns + vent + scatter + decal + fill,
                                recursing into a shaft symbol
    corridor          0 items   <no-production:corridor>

The machinery is real — priorities, builder variants, recursion through
`emit: symbol` all work. Two things are not.

### Gap 1: nothing executes a plan

`PlacementPlan` is produced and exported and **no code consumes it**. There is
no plan-to-world step, so the tool returns a list of things and where they go,
and a caller must interpret and place all of it by hand. Each item's `role` is
a bare label — "column", "vent" — with no binding to an asset.

The pieces to close this now exist: `asset_find_by_look` resolves a phrase to
an asset, and `world_generate` already grounds, separates and spawns. An
executor would compose them. That is a real feature, not a wiring task, so it
is not something to start unprompted.

### Gap 2: a room is not an interior

The room productions emit a shell, some scatter and a floor fill. No doorways,
no furniture, no subdivision, no adjacency. A7's premise is that coherent
interiors are the field's admitted gap; a shell with rubble in it does not
answer that. What an interior production should contain is a design decision
about this product, not a defaulting choice.

### Done this pass

The tool now tells the truth about both. Its description says NOTHING IS
SPAWNED and that `role` is unbound; the reply carries `placed: false`; and a
seed that matches no production names the vocabulary the grammar does know
instead of returning an empty plan that reads as "this produces nothing".

### Decisions this needs

1. Should A7 include a plan executor, or does `plumb_grammar_expand` stay an
   advisory planner an agent reads and acts on?
2. What belongs in an interior production — doors and furniture zones, or
   room subdivision first?


---

## Track D progress — 2026-08-25

**D1.6 `doctor` — DONE.** `hayba-cli doctor [--project <x.uproject>]` checks
the four things that break and says what to do about each. Building it was the
easy half; running it against a real install caught two false positives in my
own checks, both from asserting a rule I had assumed rather than read:

- The dependency check read the `.uproject` for five plugin names taken from
  this plan's prose. Three were wrong, and the `.uproject` is the wrong source
  anyway — it lists only hand-toggled plugins, while UE enables a plugin's
  DECLARED dependencies itself. It called PCG "not enabled" on an install that
  had been running PCG commands all day. It now reads the declared list from
  the `.uplugin` and infers from something stronger: UE refuses to load a
  plugin whose dependencies are missing, so a reachable editor proves they
  resolved.
- The version check compared two numbers that never shared a scheme (plugin
  0.3.0, npm 1.0.0), so it flagged skew on every healthy install.

Also fixed on the way: the CLI entry guard only matched the compiled
`cli/index.js`, so running from source did nothing and exited 0 — reading as
"it worked" rather than "it never started".

**D1.7 version-skew handshake — DONE.** `HAYBA_PROTOCOL_VERSION`, one number
both halves speak, reported over the wire in `editor_get_state`. Not a product
version: the bump rule is written into both files — bump only when the wire
breaks an older peer, never for an added command, optional parameter or
response field. Silence counts as a mismatch, because only a plugin predating
the field is silent. The advice names WHICH side is behind, since "update
Hayba" is useless when there are two things to update and one is wrong.

**D1.5 README front door — DONE.** The badge said UE 5.7 while the `.uplugin`
says 5.8.0; "100+ tools across 30+ domains" was uncheckable where the generated
inventory says 239 commands across 35 handlers. The quick start implied three
tidy steps; it is two artifacts that must meet, with no prebuilt plugin
release, so it now says building from source is the real path today and adds
the missing step — run `doctor` and find out whether it worked.

### D2 measurement (measure before rewriting)

    pack        2.32 GiB
    loose       15.61 MiB across 3702 objects
    prunable    0

Loose objects and prunable garbage are already clean, so the 2.32 GiB is
**reachable history**, not the unreachable garbage a previous cleanup found.
That means `gc` will not touch it and any real reduction is `filter-repo` —
which breaks every clone and this repo owns tags that must survive. Not a
maintenance task; a decision, on evidence.

`website/assets` is 53 MB, dominated by `Gaea/` (16 JPEGs, several ~3 MB) and
`PCGex/` (a 5.7 MB PNG). Checked: **every one is referenced** by two live
gallery pages, so there is nothing orphaned to delete. Reducing it means lossy
recompression of showcase imagery, which is a judgement about how the work
looks, not a cleanup.

Also checked and NOT an issue: `website/gaea/` is a page for a separate Gaea
MCP integration (`zajalist/gaea_mcp`) that drives Gaea's own graph. It is
accurately named and unrelated to the standing rule about never framing the
erosion work as derived from that tool.

### Still open in Track D

- **D1.1 / D1.2** — publishing the npm package and prebuilt plugin zips. Both
  are outward-facing releases, not code.
- **D1.3** in-editor client auto-configurator, **D1.8** Fab listing.
- The `website/assets` compression decision above.


---

## F10 — one checked actor lookup (2026-08-25)

Called "a correctness bug, not just cleanliness" in the plan. It is worse than
that: it was data loss, and it was reproducible.

Actor labels are not unique in UE, and every resolver walked the world
returning the first name-or-label match. Proven against a live editor before
touching anything — two cubes labelled `HAYBA_DUP`, then `actor_delete`:

    before: [('StaticMeshActor_2', 0.0), ('StaticMeshActor_3', 500.0)]
    delete  -> {"deleted": true}
    after : [('StaticMeshActor_3', 500.0)]

An arbitrary actor destroyed, success reported, the caller none the wiser.

`HaybaSceneQuery` is now the single lookup. The unique object name is checked
first and wins outright, because it can only mean one thing; several label
matches returns no actor and the candidate names, so "not found" and "cannot
tell which" are different answers with different errors. The ambiguity message
names the unique alternatives — "be more specific" without saying what to be
specific WITH is not an instruction.

Adopted by every mutating site: `HaybaActorOps` Delete/Transform, and 10 call
sites across the ISM, Physics and Spline handlers. The thin pass-throughs that
migration left behind had zero callers afterwards and were deleted rather than
kept.

Verified both directions afterwards, on two different handlers:

    actor_delete   ambiguous -> refused, both actors survive
                   unique    -> deleted cleanly
    ism_add_instance ambiguous -> refused, names both candidates
                     unique    -> {"instance_index": 0, "total_count": 1}

A fix that refuses everything is not a fix, so the second half of each pair
mattered as much as the first.

### The reads, and one that was already right

`editor_focus_actor`, `mesh_extract`, the PIE label resolver and the
destructive-command snapshot now refuse an ambiguous label too. The snapshot
one matters more than "read" suggests: it feeds the before/after diff a user
approves in Plan Mode, so the wrong actor there describes a change to
something that was never touched.

`editor_focus_actor` and `mesh_extract` were label-ONLY and now accept a
unique object name as well — strictly more useful, and consistent with every
other resolver.

Verified live on a third handler: an ambiguous label is refused and names both
candidates; a unique one focuses and returns its transform.

**PIEHandler's runtime resolver already did this correctly**, counting matches
and erroring with "use actor_path from editor_pie_actor_list". The right
behaviour existed as a local solution in one handler while every other
resolver silently first-matched — which is exactly the "uniform ref semantics"
F10 asks for, and worth noticing: the codebase knew the answer, in one place,
and it never spread.

Left alone deliberately: the Validator panel's "jump to actor". It has no
error channel, and unlike a delete, selecting one of several is visible and
reversible — the user sees what got selected.


---

## F11 — the saves, surveyed (2026-08-25)

The plan says "44 stray MarkPackageDirty and 18 unverified saves converge".
Counted, and the shape is different from that.

**Saves are mostly checked already.** Of the `SavePackage` sites, the ones that
matter capture the result and error on failure. One genuine offender:
`data_set` called `UEditorAssetLibrary::SaveLoadedAsset`, discarded the return,
and returned `ok:true` regardless. A save fails for ordinary reasons — the file
is read-only, or wants a source-control checkout — and the caller was told the
property had been persisted when it existed only in memory and would be gone at
the next editor restart. Fixed: the result is checked, and the error says the
value WAS set in memory and why the save failed, because "failed" without that
distinction sends someone looking in the wrong place.

**The 50 `MarkPackageDirty` calls are mostly correct, not stray.** Marking
dirty and leaving the save to the user is a legitimate editor pattern, and this
codebase has a specific reason to prefer it: saving inline during an import
burst has crashed UE here before. Converging all of them behind a
`HaybaMutation::SaveAsset` that saves would be a behaviour change dressed as a
refactor. What is worth converging is the message and the verification, not the
decision to save.

**Not verified live.** `data_set` needs a DataAsset subclass with an editable
UPROPERTY to exercise; a base `UDataAsset` exposes none, and this project has
no DataAsset assets at all. The change compiles and is two lines, but the happy
path is unexercised — if `SaveLoadedAsset` ever returns false on a successful
save, `data_set` would now fail where it used to succeed. Worth one live check
the next time a real DataAsset exists.


---

## F14 — checked, and mostly already done (2026-08-25)

Flagged as "best value-per-effort in either codebase". Most of it no longer
applies.

**The orphaned dirs are gone.** `unreal/` holds exactly the three real plugins;
there is no `HaybaMCPNiagara/` or `HaybaMCPSequencer/` residue left to delete.

**Registration is already unified.** Satellites self-register through
`FHaybaMCPModule::RegisterExternalHandler`, and both GAS and MetaSound use
`LoadModuleChecked` — with a comment explaining that it guarantees the core
router exists first, regardless of module load order. That is the right
pattern and it is already in place.

**One thing was worth changing.** `RegisterExternalHandler` silently no-opped
when the router did not exist. Nothing reaches that today, but a dropped
handler means every command it declares simply does not exist with nothing to
explain why — and a future caller that skips `LoadModuleChecked` would get
exactly that. It now logs an error naming the domain and what to do.

Verified after: no drop logged at startup, and `metasound_create` answers
"missing package_path" rather than "unknown command" — a parameter error
proves the handler is registered without mutating anything.


---

## F12 — the precondition is real; the work needs a consumer (2026-08-25)

F12 asserts "the TCP reservation machinery already supports it". Checked, and
it does — but not for the reason the plan implies, and the answer overturns a
recorded belief.

A late response used to CRASH: a command outran the client's timeout, the
client disconnected, and the completion lambda wrote to a freed connection.
That was recorded as a live hazard with the advice "keep every command under
the client timeout".

It is fixed, and the guard is specific:

- the read loop sets `Conn->bAlive = false` rather than tearing down, so an
  in-flight task sees a flag and not a dangling pointer;
- the socket is owned by a shared ref held by both the read loop and any queued
  game-thread task, so it outlives whichever finishes last;
- `SendMessage` re-checks liveness **under `SendMutex`**, closing the race
  between a task's own guard and the read loop flagging the client dead a
  moment later.

So deferred completion is no longer blocked on crash-safety, and the stored
note saying otherwise has been corrected.

### Why F12 is not implemented here

`FHaybaHandlerResult` is `Ok`/`Err`. Adding `Deferred` is the easy half; the
hard half is that a deferred handler needs the request's id and connection to
answer later, which the router holds. Doing that without changing `Handle()`'s
signature across all 35 handlers means a current-request context the handler
can claim during dispatch — real design, not a keyword.

And it would be scaffolding. The only sensible first consumer is
`render_camera`, whose conversion is the command-contract change deliberately
left for a decision (see the async-conversions audit). Landing `Deferred` with
nothing using it produces exactly the unused capability this branch has spent
its time deleting — `checkRecipeRequires`, the CLIP tokenizer, the room grammar
that shipped to nobody.

**Do them together or not at all.** The precondition is now verified, which is
the part that was genuinely unknown.
