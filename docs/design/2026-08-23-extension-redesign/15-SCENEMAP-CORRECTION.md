# Correction: the Scene Map renderer decision rests on a wrong premise

**Not executed. The decision needs re-making with the facts below.**

## What I said, and what you approved

I presented the Scene Map as *"two implementations of the same feature"* —
`HaybaMCPSceneMapPanel.cpp` (223 lines, native `SCanvas`) versus
`HaybaMCPSceneMapWebPanel.cpp` (126 lines, `SWebBrowser`) — recommended keeping
the web one and deleting the native one, and you approved that.

Two facts I did not check before recommending it. Both change the picture.

## 1. It is a shipped user setting, not accidental duplication

`HaybaMCPSettings.h:111`

```cpp
enum class ESceneMapRenderer : uint8 { Auto = 0, Native = 1, Web = 2 };
ESceneMapRenderer SceneMapRenderer = ESceneMapRenderer::Auto;
```

`HaybaMCPMainPanel.cpp:339` reads it and branches. The comment there is
explicit that this is deliberate: *"Pick the renderer per user setting. Auto →
Web for now; Phase 2 can later add a GPU heuristic."*

So these are not two accidental implementations. They are a documented
Web/Native/Auto choice with a stated future purpose, and the fallback path is
the one a user selects when the web view does not suit their machine. Deleting
Native removes a shipped setting and the reason it exists.

## 2. The native panel is wired into the router's push chain

`HaybaMCPModule.h:53` holds `TWeakPtr<SHaybaMCPSceneMapPanel> SceneMapPanel`,
and `HaybaMCPCommandHandler.cpp:310` pins it to push `scene_get_graph` results
into the panel. Only the **native** panel is registered there —
`MainPanel.cpp:358` does `Module->SceneMapPanel = N` in the Native branch and
has no equivalent in the Web branch.

So `scene_get_graph`'s panel push works **only when the Native renderer is
selected**. Deleting Native would not merely remove a renderer; it would remove
the only receiver of a router push path, silently. And it means the push
already does nothing today under the default `Auto` → Web.

That second part is a live defect independent of any deletion: **the command
pushes scene-graph results into a panel that is not the one on screen by
default.**

## What this changes

- **Do not delete the native renderer** on the strength of my earlier
  recommendation. It was made without either of these facts.
- The real question is different from the one I asked you. Not *"which renderer
  survives"* but *"should the renderer remain a user choice at all, and if so
  why does only one of them receive router pushes?"*
- The `Module->SceneMapPanel` push path needs fixing regardless of the answer:
  either both renderers register, or the push moves to the
  `OnCommandCompleted` multicast proposed in R3, which does not care which
  widget is on screen.

## Why this is recorded rather than fixed

Executing the deletion would have destroyed a user-facing setting on the basis
of an analysis I had already found to be incomplete. Fixing the push path
instead is a real change to how a command reaches the UI, and R3 already
proposes replacing that whole mechanism — so patching it now would likely be
work thrown away.

Both are decisions, not maintenance.

## Related

`01b-ARCH-REVIEW-CPP.md` §D lists "Two Scene Maps" under *duplicate
implementations*. That entry is wrong for the same reason and should be read
with this correction.
