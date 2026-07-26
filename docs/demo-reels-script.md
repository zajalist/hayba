# Hayba Demo-Reel Scripts

> Storyboards for short screen-recorded marketing reels. Each reel shows an AI copilot
> driving **real** Unreal Engine work through the Hayba MCP toolkit, from a chat prompt,
> on the user's own machine with their own API key. Tool names and arguments below are
> faithful to the shipped codebase (`mcp-tools/hayba-mcp/src/tools/**`) so these scripts
> double as an executable record-and-verify test plan.

---

## 1. Intro — the narrative arc

The series has one throughline: **you type intent, and a real engine builds it — safely, locally, and reproducibly.** Reel 1 proves *breadth* (a spoken sentence becomes a populated, lit, watered landscape). Reel 2 proves *authorship* (the agent doesn't just place props — it directs a camera and cuts a cinematic). Reel 3 proves *determinism* (a VFX moment advanced to an exact, repeatable frame). Reel 4 proves *trust* (the plan-mode approval gate and known-crasher guardrails turn "AI touching my project" from a risk into a reviewable, crash-proof workflow). The unifying tagline: **"Your engine. Your key. Your machine. The agent just does the work."** No cloud round-trip owns your project; every destructive step is proposed, shown, and approved before it runs.

Positioning notes that must survive editing:
- **Local-first + BYOK** — the copilot runs against the user's own key; frames should show the key field / model picker once, briefly.
- **Crash-resilient + honest** — guardrails refuse known-crashers *cleanly*; tools report set-success truthfully (e.g. `render_camera` verifies the file's magic bytes before claiming success).
- **Breadth, not a toy** — landscape, foliage, lighting, water, sequencer, niagara, PCG, validation — one surface (~230 tools).

---

## 2. Reel scenarios

Each reel: side-by-side UE viewport (left) + copilot Slate panel (right). "Approve" moments are the money shots — hold on them.

---

### Reel 1 — "Prompt to populated landscape"
**Hook (site caption):** *"One sentence. A whole biome — grounded, lit, and watered. Built live in your editor."*
**Target length:** ~55s

**Copilot chat prompt (typed by user):**
> "Turn this open field into a misty pine valley — dense conifers thinning upslope, a lake in the low ground, and cool morning light."

**Beat-by-beat storyboard:**

| # | Viewer sees | Real MCP tool call(s) | Plan-gate? | Caption / VO |
|---|-------------|----------------------|-----------|--------------|
| 1 | Empty landscape actor in viewport; user types the prompt, hits enter | — (agent turn begins) | — | "Describe the world you want." |
| 2 | Agent lists the scene, confirms it found the field | `actor_list { class_filter: "Landscape" }` → `actor_inspect` | no (read) | "It reads your actual scene first." |
| 3 | A dry-run scatter plan appears as a bounded preview overlay | `world_generate { area_actor: "Field_Center", prompt: "misty pine valley, dense conifers thinning upslope", radius_cm: 12000, count: 220, seed: 1337, dry_run: true }` | no (dry_run) | "Scatter and *prove* — it validates every instance in memory: grounded, non-interpenetrating." |
| 4 | **Approve card** — "world_generate will spawn 220 instances" — user clicks Approve | `world_generate { …same args…, dry_run: false }` | **YES — non-idempotent spawn** | "Nothing lands until you approve." |
| 5 | Conifers pop in across the valley, denser low, sparse upslope | (continuation of `world_generate`) | — | "Foliage, grounded to the terrain." |
| 6 | Undergrowth pass added on slope band | `foliage_type_create { … }` → `foliage_scatter_paint { … }` (approve) | **YES** | "Layered undergrowth, on a slope mask." |
| 7 | Water fills the low ground | `water_check_plugin` → `water_body_lake_create { location:[…], size:… }` (approve) | **YES** | "A lake finds the low ground." |
| 8 | Cool morning light sweeps the scene; fog rolls in | `sky_setup { preset:"morning", sun_pitch: 12 }` → `light_set { … color:[cool], intensity:… }` → `fog_configure { density:0.02 }` | **YES** (light spawn is non-idempotent) | "Mood, in one move." |
| 9 | `wait_for_shaders` spinner, then crisp frame | `wait_for_shaders` → `wait_for_idle` | no | "It waits for shaders so the shot is real." |

**Payoff shot:** `render_camera` to a low golden-hour angle over the lake —
`render_camera { camera:{ kind:"transform", location:[…], rotation:[…], fov:60 }, output_path:"…/reel1_hero.png", width:1920, height:1080, format:"png" }` — the returned verified PNG fills the screen. Caption: **"From one sentence to a shot you can ship."**

---

### Reel 2 — "Author a cinematic"
**Hook:** *"The agent doesn't just place props — it directs the camera."*
**Target length:** ~50s

**Copilot chat prompts:**
> 1. "Drop a hero rock formation and a lone tree on the ridge, then set up a 6-second flythrough that pushes past them toward the lake."
> 2. "Give me the final frame at 1440p."

**Beat-by-beat storyboard:**

| # | Viewer sees | Real MCP tool call(s) | Plan-gate? | Caption / VO |
|---|-------------|----------------------|-----------|--------------|
| 1 | User types prompt 1 | — | — | "Set the scene." |
| 2 | Two meshes resolve and spawn on the ridge | `actor_spawn_from_asset { asset_path:"…/SM_Rock_01", label:"Hero_Rock" }`, `actor_spawn_from_asset { asset_path:"…/SM_GiantTree_01", label:"Lone_Tree" }` (approve) | **YES** | "Real assets from your project." |
| 3 | Tree seats to the ground | `actor_transform { actor_id:"Lone_Tree", location:[…, -380] }` | **YES** | (nod to SM_GiantTree pivot offset) |
| 4 | A new Level Sequence opens in the editor | `seq_new { name:"Ridge_Flythrough", path:"/Game/Cine" }` → `seq_open` | **YES** | "It authors a real Level Sequence." |
| 5 | A CineCameraActor is spawned and bound | `actor_spawn { class_path:"/Script/CinematicCamera.CineCameraActor", label:"ReelCam" }` → `seq_bind_actor { sequence:"Ridge_Flythrough", actor_id:"ReelCam" }` | **YES** | "Camera, bound." |
| 6 | Playback range set to 6s; a transform track appears | `seq_playback_range { start_frame:0, end_frame:180 }` → `seq_track_add { binding:"ReelCam", track:"Transform" }` | **YES** | "Six seconds." |
| 7 | Two keyframes drawn — a start wide, an end push-in | `seq_transform_keyframe { binding:"ReelCam", frame:0, location:[…], rotation:[…] }`, `seq_transform_keyframe { binding:"ReelCam", frame:180, location:[…closer…], rotation:[…toward lake…] }` | **YES** | "Keyframes it can explain." |
| 8 | A camera cut track locks the shot to ReelCam | `seq_camera_cut { binding:"ReelCam", start_frame:0, end_frame:180 }` | **YES** | "One clean cut." |
| 9 | Green validation tick | `seq_validate { sequence:"Ridge_Flythrough" }` | no | "It checks its own work." |
| 10 | Timeline scrubs; the push-in plays in-viewport | (editor playback) | — | "And it plays." |

**Payoff shot (prompt 2):** `render_camera { camera:{ kind:"actor", actor:"ReelCam" }, output_path:"…/reel2_final.png", width:2560, height:1440, format:"png" }` — final composed frame. Caption: **"Prompt to composed shot, no timeline scrubbing by hand."**

---

### Reel 3 — "A VFX moment, made reproducible"
**Hook:** *"Spawn it, drive it, and freeze the exact same frame every time."*
**Target length:** ~40s

**Copilot chat prompt:**
> "Add embers rising off the rock, dial the spawn rate up, and give me the frame at exactly 2 seconds of sim — I want it identical on every run."

**Beat-by-beat storyboard:**

| # | Viewer sees | Real MCP tool call(s) | Plan-gate? | Caption / VO |
|---|-------------|----------------------|-----------|--------------|
| 1 | User types prompt | — | — | "Ask for the effect." |
| 2 | Agent probes what Niagara can do here | `niagara_capability_probe` → `niagara_systems` | no (read) | "It checks the engine's actual capabilities." |
| 3 | An ember system is placed at the rock | `niagara_create_from_template { template:"embers" }` → `niagara_place_actor { location:[…rock top…], label:"Embers_FX" }` (approve) | **YES** | "Embers, placed." |
| 4 | Parameter list surfaces in chat | `niagara_param_list { component:"Embers_FX" }` | no | "Every exposed parameter, listed honestly." |
| 5 | Spawn rate ramps up live | `niagara_param_set { component:"Embers_FX", name:"SpawnRate", value: 450 }` | **YES** | "Dialed in from chat." |
| 6 | Sim advances deterministically to t=2s | `niagara_advance_simulation { component:"Embers_FX", seconds: 2.0, fixed_dt: 0.0166 }` | no | "Advanced to an exact sim time — deterministic, not a lucky screenshot." |
| 7 | Validation tick | `niagara_validate { component:"Embers_FX" }` | no | "Verified." |

**Payoff shot:** `render_camera { camera:{ kind:"transform", location:[…], rotation:[…], fov:50 }, output_path:"…/reel3_embers_t2.png", width:1920, height:1080, format:"png" }`. Run it twice on screen → **byte-identical** result. Caption: **"Same prompt, same frame, every time."**

---

### Reel 4 — "Safe by design"
**Hook:** *"AI in your project — but nothing destructive happens without your click, and known crashers never fire."*
**Target length:** ~45s

**Copilot chat prompts:**
> 1. "Clear out that whole test foliage patch and delete the scratch actors."
> 2. "Now load the blank benchmark map to start fresh."

**Beat-by-beat storyboard:**

| # | Viewer sees | Real MCP tool call(s) | Plan-gate? | Caption / VO |
|---|-------------|----------------------|-----------|--------------|
| 1 | User types prompt 1 | — | — | "Ask for something destructive." |
| 2 | Agent proposes a plan card listing exactly what it will remove | (proposed) `foliage_clear_type { type:"Undergrowth_01" }`, `actor_delete { actor_id:"Scratch_A" }`, `actor_delete { actor_id:"Scratch_B" }` | **YES — batched approve** | "It proposes. You review the exact operations." |
| 3 | User clicks Approve; foliage + actors vanish | (same calls execute) | — | "You approve. Then it runs." |
| 4 | Honest report: "3/3 succeeded" | tool results / `actor_list` re-check | no | "Honest set-success — no silent partial fails." |
| 5 | User types prompt 2 (the trap) | — | — | "Now ask for a known editor crasher." |
| 6 | Agent **refuses cleanly** — a guarded message, not a crash | guardrail blocks `load_map` / `new_blank_map` (known-crashers guard, `tools/guards/known-crashers.ts`) | blocked pre-exec | "A known crasher is refused *before* it can touch the editor." |
| 7 | Agent offers the safe path instead | suggests operator-driven map switch / a non-crashing alternative | — | "It hands you the safe route instead." |
| 8 | Editor still alive, project intact | `hayba_check_ue_status` → green | no | "Editor still standing. Project intact." |

**Payoff shot:** split card — left: the green "3/3 succeeded" report; right: the clean guardrail refusal message with the editor visibly alive behind it. Caption: **"Powerful automation you can actually trust with your project."**

---

## 3. Production notes

**Window layout (all reels):**
- **Left ~62%:** Unreal Engine editor, viewport maximized (G to hide gizmos for hero beats), Outliner visible on approve beats so spawns/deletes are legible.
- **Right ~38%:** the copilot **Slate panel** docked in-editor — prompt box at bottom, streaming tool-call log above, and the **plan-mode Approve card** rendered inline.
- Show the BYOK model/key row **once** in Reel 1's first 3 seconds (a quick pan), never again — establishes local-first without belaboring it.

**Capture order (efficiency):**
1. Record Reel 1 first — it produces the populated landscape that Reels 2–4 reuse (rock, tree, foliage patch, lake). Don't tear it down between takes.
2. Reel 2 (cinematic) on the same level.
3. Reel 3 (VFX) on the same level — place embers on the Reel 2 rock.
4. Reel 4 last — it deletes scratch actors, so it must run after the others are captured. Pre-place `Scratch_A`/`Scratch_B` and an `Undergrowth_01` patch just for it.

**What to cut:**
- Trim shader-compile / `wait_for_shaders` dead time to a ~1s spinner beat (keep one, it sells "the shot is real").
- Cut streaming-log scroll to the tool name + args line, then the result line — don't show full JSON.
- Keep every Approve click at full speed; do **not** speed-ramp the approval moment (it's the trust beat).

**Music / pacing:**
- Ambient, building pad; Reels 1–2 relaxed (~50–55s), Reels 3–4 tighter and punchier (~40–45s).
- Hit a small stinger on each render_camera payoff reveal.
- Reel 4 goes quiet on the guardrail refusal beat — silence sells "it stopped."

**Site placement (actual files):** the website package is `website/` (repo root). It is a static, no-build site (`config.js` placeholders are served as-is — see deploy notes). Slot the reels into the landing page **`website/index.html`** as an autoplay-muted `<video>` gallery — add a `#demo-reels` section near the existing hero/showcase area. The dedicated showcase page **`website/showcase/`** is the natural home for the full four-reel set with captions; the hooks above are written to be the on-card captions there. Register the media under `website/assets/` (e.g. `website/assets/reels/reel1-landscape.mp4` … `reel4-safe.mp4`). Reel 1 is the hero (top of `index.html`); Reels 2–4 live in the `showcase/` grid.

---

## 4. Shot list / asset checklist (template project prerequisites)

Before a start-to-finish recording session, the template level must contain:

- [ ] A real **Landscape** actor (not a placeholder StaticMeshActor — SurfaceSampler/scatter need a genuine Landscape; see the landscape_import path). Reasonably large, gently rolling with a clear **low basin** for the lake.
- [ ] The basin low enough that `water_body_lake_create` reads as "the low ground."
- [ ] An **area/anchor actor** at valley center labeled `Field_Center` for `world_generate area_actor`.
- [ ] Project StaticMeshes for `world_generate` to resolve per layer: a **conifer/canopy** mesh, an **undergrowth** mesh, a **rock** mesh, **groundcover**. (world_generate resolves the *project's own* meshes — they must exist and be indexed.)
- [ ] Hero cinematic meshes: `SM_Rock_01` and `SM_GiantTree_01` (remember the ~+380 pivot → seat at z=-380).
- [ ] **Water plugin enabled** (`water_check_plugin` should return green) — otherwise Reel 1 beat 7 / lake fails.
- [ ] **Niagara** available with an ember-style template reachable via `niagara_create_from_template` (verify with `niagara_capability_probe` + `niagara_systems` beforehand).
- [ ] A **CineCamera** class available (`/Script/CinematicCamera.CineCameraActor`).
- [ ] Reel 4 scratch content pre-placed: actors `Scratch_A`, `Scratch_B`, and a foliage type `Undergrowth_01` with instances — so the destructive-approve beat has something real to remove.
- [ ] Copilot configured with a working **BYOK key + model** so the first Reel 1 pan shows a live, connected panel.
- [ ] A known blank/benchmark map name to *attempt* to load in Reel 4 (the guarded `load_map`/`new_blank_map` trap) — confirm the guardrail actually blocks it in a rehearsal so the refusal is genuine, not staged.
- [ ] Output dir for `render_camera` writable, and `hayba_check_ue_status` returning healthy at session start.

**Rehearsal gate:** dry-run Reels 1–3 with `dry_run:true` / read-only calls first to confirm scatter plans, bindings, and param names resolve on this template before rolling final capture.
