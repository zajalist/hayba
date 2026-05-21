# `render_camera` — Verified Single-File UE Screenshot Pipeline

**Date:** 2026-05-21
**Status:** Design approved, ready for implementation plan
**Scope:** One new MCP tool (`render_camera`) plus a C++ handler. Hides the internal `HaybaMCPCaptureActor` rig from screenshots and `actor_list`. Folds `editor_capture_viewport` into a thin TS wrapper with capability fallback. Sibling to `wait_for_idle` (which it consumes internally). Closes `.scratch/mcp-architectural-issues.md` #2 and #13.

## Problem

Per the post-mortem, three screenshot mechanisms exist and none is reliable:

- **`editor_capture_viewport`** — renders to base64 inline; truncates against agent context limits; capture actor visible from other camera angles.
- **`unreal.AutomationLibrary.take_high_res_screenshot(path)`** — sometimes writes a 17 KB blank PNG and reports success; sometimes writes nothing.
- **`HighResShot N x N` console command** — works for ~20 shots then wedges silently; only fix is editor restart.

The `HaybaMCPCaptureActor` (the `SceneCapture2D` rig that backs `editor_capture_viewport`) is itself a visible actor in every level the MCP touches — appears as a "blue spray bottle" in hero shots from other angles, and pollutes `actor_list` responses.

## Goals

1. **Single first-class `render_camera` tool** that writes a file to disk and **verifies** the file exists, has plausible magic bytes, and matches requested dimensions before returning ok.
2. **Discriminated camera input:** either an existing actor reference or an inline transform. Transform path uses the rebuilt hidden internal capture actor; the LLM never has to know that actor exists.
3. **Consume `wait_for_idle` internally** — waits for shaders, assets, and at least one world tick by default before capturing so half-loaded scenes don't render.
4. **Hide the internal capture actor** — `bHidden=true`, `bHiddenInGame=true`, tagged `"HaybaMCP_Internal"`, marked editor-only. `actor_list` filters by tag unless `include_internal: true`.
5. **No base64 inline** — caller reads the file off disk if pixels are needed in-agent.
6. **`editor_capture_viewport` keeps working** as a thin TS wrapper with per-process capability-flag fallback (same pattern as Layer 1's `wait_for_shaders` wrapper).

## Non-goals

- Thumbnail strip, multi-camera batch render, video / Sequencer capture, depth / normal / aux output passes — each its own follow-up.
- Replacing `HighResShot` console command itself — `render_camera` is a parallel, deterministic path.
- Compositing or post-process overrides per shot — caller pre-configures the camera.
- Frustum / LOS introspection (issue #11) — separate spec.

## Architecture

One TS-side meta-tool `render_camera` routes via `executeCommand('render_camera', args)` to one C++ handler `FHaybaMCPRenderHandler`. The handler:

1. Resolves the camera. Actor path → `FindActorByPath` in the active editor world. Transform → poses the rebuilt hidden `HaybaMCPCaptureActor` at the requested location/rotation/FOV.
2. Invokes the shared `wait_for_idle` predicates *in-process* (no TCP round-trip — predicates extracted into a `HaybaIdle::WaitForSubsystems` helper consumed by both `FHaybaMCPIdleHandler` and this one). Default subsystems: `['shaders','assets','world_tick']`. Uses `wait_timeout_s` from the call.
3. Configures the chosen camera's `USceneCaptureComponent2D` for the requested width/height/format (PNG default), creates an appropriately-typed `UTextureRenderTarget2D`, calls `CaptureScene()`.
4. Reads the render target back via `FImageUtils::GetRenderTargetImage` / `FImageUtils::ExportRenderTarget2DAsPNG/EXR/JPG` (concrete API per UE 5.7).
5. Validates: file exists, size ≥ minimum threshold for the format (8 bytes for magic check), first bytes match format magic (`89 50 4E 47` for PNG, `76 2F 31 01` for EXR header start, `FF D8 FF` for JPG), dimensions match request via a re-load of the file's header.
6. Returns `{ok, path, width, height, fileBytes, renderDurationMs, waitMs}` or structured error.

File output anchored to `Saved/Screenshots/Hayba/` under the project unless `output_path` is absolute. Default name when `output_path` omitted: `hayba_<YYYYMMDDhhmmss>_<uuid8>.<ext>`.

### File layout

New:
```
mcp-tools/hayba-mcp/src/tools/render-camera.ts
mcp-tools/hayba-mcp/src/tools/render-camera.test.ts
mcp-tools/hayba-mcp/tests/render-camera-integration.test.ts
unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPRenderHandler.{h,cpp}
```

Modified:
```
mcp-tools/hayba-mcp/src/tools/editor/editor-capture-viewport.ts   (thin wrapper with capability fallback)
mcp-tools/hayba-mcp/src/tools/index.ts                            (register render_camera)
mcp-tools/hayba-mcp/src/tools/routing/packs.yaml                  (add render_camera to editor pack)
unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPIdleHandler.cpp  (extract HaybaIdle::WaitForSubsystems helper consumed by both handlers)
unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCaptureActor.cpp  (hide + tag + editor-only)
unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCaptureActor.h    (mirror)
unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPActorHandler.cpp  (actor_list filters HaybaMCP_Internal tag)
unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPModule.cpp        (register handler)
mcp-tools/hayba-mcp/CHANGELOG.md
```

## Components

### TS — `render-camera.ts`

```ts
export const schema = z.object({
  camera: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('actor'), actor: z.string().describe('Full actor path, e.g. /Game/Maps/L1.L1:PersistentLevel.HeroCamera') }),
    z.object({
      kind: z.literal('transform'),
      location: z.tuple([z.number(), z.number(), z.number()]),
      rotation: z.tuple([z.number(), z.number(), z.number()]).describe('[pitch, yaw, roll] in UE order'),
      fov: z.number().min(5).max(170).optional().default(90),
    }),
  ]),
  output_path: z.string().optional().describe('Absolute or project-relative path. Default: Saved/Screenshots/Hayba/hayba_<ts>_<uuid>.<ext>'),
  width: z.number().int().min(64).max(8192).optional().default(1920),
  height: z.number().int().min(64).max(8192).optional().default(1080),
  format: z.enum(['png', 'exr', 'jpg']).optional().default('png'),
  wait_for_subsystems: z.array(z.enum(['shaders','assets','gc','pcg','world_tick'])).optional()
    .default(['shaders','assets','world_tick']),
  wait_timeout_s: z.number().int().min(0).max(300).optional().default(30),
});

export const meta: HaybaToolMeta = {
  cost: 'high',
  effects: ['filesystem_write'],
  when: 'You need to see what the level looks like from a camera. Returns a disk path you read separately if you need pixels.',
  not_when: 'Pure metadata read — no scene change to visualize.',
};

export async function handleRenderCamera(params: ...);  // Standard executeCommand dispatch with timeout = (wait_timeout_s + 30) * 1000.
```

**Return shape:**
```ts
type RenderResult =
  | { ok: true; path: string; width: number; height: number; fileBytes: number; renderDurationMs: number; waitMs: number }
  | { ok: false; error:
      | { kind: 'actor_not_found'; attempted: string }
      | { kind: 'file_not_written'; attempted: string; engineHint?: string }
      | { kind: 'file_invalid'; attempted: string; sizeBytes: number; firstBytesHex: string; expectedFormat: string }
      | { kind: 'wait_timeout'; timedOut: string[] } };
```

### TS — `editor-capture-viewport.ts` (modified to wrapper)

Per-process capability flag `renderCameraAvailable`. First call tries `executeCommand('render_camera', { camera: { kind: 'transform', ... }, ... })`; on `unknown_command` falls back to legacy `editor_capture_viewport` for the rest of the process. Mirrors the `wait_for_shaders` pattern.

### C++ — `FHaybaMCPRenderHandler`

```cpp
class FHaybaMCPRenderHandler : public IHaybaMCPHandler {
public:
    FString GetDomain() const override { return TEXT("render"); }
    TArray<FString> GetCommands() const override { return { TEXT("render_camera") }; }
    FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;
};
```

Implementation outline:
1. Parse params (camera union, output_path, width, height, format, wait_for_subsystems, wait_timeout_s).
2. Resolve `OutPath`: absolute kept as-is; relative anchored to `FPaths::ProjectSavedDir() / "Screenshots/Hayba"`; auto-generated when omitted. Create parent dir via `IFileManager::Get().MakeDirectory(*ParentDir, /*Tree=*/true)`.
3. Resolve camera (game thread):
   - `actor`: `FSoftObjectPath(ActorStr).TryLoad()` → cast to `AActor`. Look for first `UCameraComponent` or `USceneCaptureComponent2D` child. If only `UCameraComponent`, build a transient `USceneCaptureComponent2D` paired to its transform/FOV.
   - `transform`: get or spawn `HaybaMCPCaptureActor`, set its transform + FOV, use its `SceneCapture` component.
4. Wait: invoke `HaybaIdle::WaitForSubsystems({wait_for_subsystems}, wait_timeout_s)` (helper extracted from existing `FHaybaMCPIdleHandler`). On wait timeout, return `{kind:'wait_timeout', timedOut}`.
5. Render (game thread): allocate `UTextureRenderTarget2D` matching width/height + format-appropriate pixel format, assign to `SceneCapture->TextureTarget`, set `bCaptureEveryFrame=false`, `bCaptureOnMovement=false`, call `SceneCapture->CaptureScene()`.
6. Write: `FImageUtils::SaveImageByExtension(*OutPath, ...)` or per-format equivalent (`ExportRenderTarget2DAsPNG/EXR/HDR`).
7. Verify: `FFileHelper::LoadFileToArray` first 12 bytes; assert magic per `format`; assert file size > magic length; `FImageUtils::LoadImageFromFile` to verify width/height match request.
8. Build response → return.

### C++ — `HaybaMCPCaptureActor` rebuild

Constructor changes:
```cpp
AHaybaMCPCaptureActor::AHaybaMCPCaptureActor() {
  bHidden = true;                    // hide in editor viewport
  SetActorHiddenInGame(true);
  bIsEditorOnlyActor = true;         // strip from cooked builds
  Tags.Add(TEXT("HaybaMCP_Internal"));
  RootComponent->SetVisibility(false, /*Propagate=*/true);
  // Disable editor sprite billboard if present.
  if (auto* Sprite = FindComponentByClass<UBillboardComponent>()) {
    Sprite->SetVisibility(false);
    Sprite->bHiddenInGame = true;
  }
}
```

### C++ — `actor_list` filter

In `FHaybaMCPActorHandler::HandleActorList` (or equivalent), after gathering candidates, drop any actor whose `Tags.Contains(TEXT("HaybaMCP_Internal"))` unless `Params->GetBoolField(TEXT("include_internal"))` is true. New `include_internal` param documented in the schema.

## Data flow

**Happy path — transform camera.**
1. LLM: `render_camera({ camera: {kind:'transform', location:[100,200,300], rotation:[-30,45,0], fov:75} })`.
2. TS validates, dispatches.
3. C++ resolves output path → `Saved/Screenshots/Hayba/hayba_20260521_120000_a1b2c3d4.png`.
4. Schedules game-thread work: pose `HaybaMCPCaptureActor`, configure render target 1920x1080 PNG.
5. Runs `HaybaIdle::WaitForSubsystems({'shaders','assets','world_tick'}, 30)` — blocks the TCP-handler thread on `FEvent` per the wait_for_idle pattern.
6. On settle: `SceneCapture->CaptureScene()`, save file, verify magic + dims.
7. Returns `{ok:true, path:"…/hayba_….png", width:1920, height:1080, fileBytes:842311, renderDurationMs:45, waitMs:312}`.

**Happy path — actor camera.** Same except step 4 finds the named actor and uses its components directly (no pose).

**Error — actor not found.** Step 3 → `{ok:false, error:{kind:'actor_not_found', attempted}}`.

**Error — file not written.** Step 6 fails or step 7 finds 0-byte file → `{ok:false, error:{kind:'file_not_written', attempted, engineHint: <last error from FShaderCompilingManager or render thread error log>}}`.

**Error — wait timeout.** Step 5 returns timeout → preserved as `{ok:false, error:{kind:'wait_timeout', timedOut}}`.

## Error handling (full table)

| Failure | Response |
|---|---|
| `camera.actor` path doesn't resolve | `{ok:false, error:{kind:'actor_not_found', attempted}}` |
| Actor resolves but has no camera/scene-capture component | `{ok:false, error:{kind:'actor_not_found', attempted, reason:'no_camera_component'}}` (uses same kind for simplicity) |
| `output_path` parent dir creation fails | `{ok:false, error:{kind:'file_not_written', attempted, engineHint:'mkdir failed'}}` |
| `SceneCapture->CaptureScene()` no-ops or throws | `{ok:false, error:{kind:'file_not_written', attempted, engineHint}}` |
| File written but size < 8 bytes (no magic) | `{ok:false, error:{kind:'file_invalid', attempted, sizeBytes, firstBytesHex:'', expectedFormat}}` |
| Magic bytes mismatch | `{ok:false, error:{kind:'file_invalid', attempted, sizeBytes, firstBytesHex, expectedFormat}}` |
| Re-loaded image dimensions ≠ request | `{ok:false, error:{kind:'file_invalid', attempted, sizeBytes, firstBytesHex:'(dimensions mismatch)', expectedFormat}}` |
| Wait phase times out | `{ok:false, error:{kind:'wait_timeout', timedOut}}` (forwarded from wait_for_idle) |
| TCP transport error mid-render | TS `UeToolError{code:'transport'}` with one retry, standard handling |
| UE plugin doesn't know `render_camera` | `editor_capture_viewport` wrapper's capability fallback kicks in; direct `render_camera` calls surface `unknown_command` |

## Testing

### TS unit (`render-camera.test.ts`)

- Schema: discriminated union accepts both shapes; rejects mixed shapes; rejects unknown format; dimension bounds.
- `handleRenderCamera` dispatches `render_camera` with timeout = `(wait_timeout_s + 30) * 1000`.
- `editor-capture-viewport.ts` wrapper: per-process capability flag — first call tries `render_camera`, on `unknown_command` flips flag and falls back to legacy `editor_capture_viewport` for subsequent calls.

### TS integration (`render-camera-integration.test.ts`)

Mocked sender returning canned shapes:
- `{ok:true, path, width, height, fileBytes, renderDurationMs, waitMs}` — TS unwraps cleanly.
- `{ok:false, error:{kind:'file_not_written', attempted, engineHint}}` — preserved in response.
- `{ok:false, error:{kind:'file_invalid', ...}}` — preserved.
- `{ok:false, error:{kind:'wait_timeout', timedOut:['shaders']}}` — preserved.

### C++ unit (UE plugin sub-PR)

- Path resolution: absolute path stays; relative anchors under `Saved/Screenshots/Hayba/`; auto-generated has timestamp + uuid.
- Magic-byte validation: PNG / EXR / JPG signatures.
- Dimension re-load matches request.
- HaybaMCPCaptureActor: constructor sets `bHidden=true`, tag present, root visibility false.
- actor_list filter: filters by tag unless `include_internal=true`.

### Smoke (manual, with UE running)

- `render_camera({camera:{kind:'transform',location:[0,0,1000],rotation:[-90,0,0]},fov:90})` writes a top-down PNG and returns path.
- Open the PNG, verify it's not the 17KB-blank-PNG class of failure.
- `render_camera` with an actor reference to an existing `CineCameraActor` renders from that view.
- `actor_list({})` does NOT include `HaybaMCPCaptureActor` in results; `actor_list({include_internal:true})` does.
- After a PCG generate burst: `render_camera({...,wait_for_subsystems:['pcg','shaders']})` waits for completion before rendering.

## Risks & mitigations

- **`HaybaIdle::WaitForSubsystems` helper extraction** — refactor of the still-fresh `FHaybaMCPIdleHandler`. Risk: TCP-handler thread blocking pattern needs careful extraction. Mitigation: helper returns a `bool bAllSettled` + `TArray<FString> TimedOut` so the render handler can convert to the right error shape without re-implementing.
- **PNG/EXR/JPG format handling differs by UE version.** Mitigation: implementation uses `FImageUtils::SaveImageByExtension` (UE 5.5+ unified API) with per-format fallbacks if the unified call isn't present.
- **`FImageUtils::LoadImageFromFile` may be slow for 8192² re-verification.** Mitigation: only re-load file *header* (first ~1024 bytes) for the dimension check — sufficient for PNG (IHDR chunk is at fixed offset) and EXR (header text), and JPG SOF marker.
- **`HaybaMCPCaptureActor` already exists in user levels** — changing constructor doesn't retroactively hide already-spawned instances. Mitigation: handler at startup iterates existing instances and applies the hide/tag changes (one-time migration in `FHaybaMCPModule::StartupModule` or first `render_camera` call).
- **Live editor uses `geoforge/Plugins/HaybaMCPToolkit/`** (architectural-issues #5) — this PR's C++ changes won't take effect there without sync. Mitigation: capability-flag fallback in TS so `editor_capture_viewport` keeps working; document sync requirement in PR.

## Out of scope (separate specs)

- Frustum / LOS introspection (#11).
- Composition primitives (`frame_target`, `find_clear_zone`).
- Lighting presets (#10).
- Operation journal (#12).
- Plugin source dedup (#5).
- Video / Sequencer capture.
- Multi-camera batch render.
- Depth / normal / aux passes.
