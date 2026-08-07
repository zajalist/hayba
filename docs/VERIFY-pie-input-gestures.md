# VERIFY — PIE wheel and captured drag

**Status: the fix is written, UNVERIFIED IN-EDITOR.** It was authored while an editor
instance was owned by other agents, so nothing here has been run against a live PIE
session. The plugin binary in that editor is the OLD one. Nothing below is a result;
it is the experiment to run.

Branch: `fix/mcp-defect-batch-aug01`.
Changed: `unreal/.../handlers/HaybaMCPPIEHandler.cpp`, `unreal/.../Public/HaybaMCPParams.h`
(new `HaybaPieGesture`), `mcp-tools/hayba-mcp/src/tools/pie/pie-mouse.ts`,
`mcp-tools/hayba-mcp/src/legacy-commands/sidecar.json`.

Prerequisite: **rebuild the plugin and restart the editor.** Every number below reads
from the new binary; running these against the running editor measures the old bug.

---

## What was actually wrong

Two defects, one shared shape: input was synthesised into a pipe the widget was not
listening to, and nothing in the response said so.

**A. The wheel never reached Slate.** `action:"scroll"` was
`UGameViewportClient::InputKey(EKeys::MouseWheelAxis, IE_Axis)` — the *game* input
pipeline. `FSlateApplication` never saw it, so `SWidget::OnMouseWheel` could not fire
for any widget, ever. Now it builds an `FPointerEvent` carrying the wheel delta exactly
as `FSlateApplication::OnMouseWheel(Delta, CursorPos)` does and dispatches it through
`FSlateApplication::ProcessMouseWheelOrGestureEvent`, so it hit-tests under the cursor
and bubbles outward (inner scrollbox first). The game viewport is still served, because
whatever the UI declines reaches `SViewport` → `FSceneViewport::OnMouseWheel`, which
raises `MouseScrollUp`/`MouseScrollDown` and the `MouseWheelAxis`. The old
viewport-only call survives solely as a fallback for when Slate returns false.

**B. Every synthetic move carried a zero cursor delta.** This is the root cause of the
dead drag, and it is one line of ordering. `FSlateApplication::SetCursorPos` ends in

```cpp
void FSlateUser::UpdatePointerPosition(uint32 PointerIndex, const FVector2f& Position)
{
    PointerPositionsByIndex.FindOrAdd(PointerIndex)         = Position;
    PreviousPointerPositionsByIndex.FindOrAdd(PointerIndex) = Position;   // <-- both
}
```

so after a `SetCursorPos`, `GetLastCursorPos()` **is the destination**. The harness built
its move event from `(GetCursorPos(), GetLastCursorPos())` *after* moving, which is
always `CursorDelta == (0,0)`. `SScrollBar::OnMouseMove` is blunt about what that means:

```cpp
if ( this->HasMouseCapture() )
    if (!MouseEvent.GetCursorDelta().IsZero())
        ... scroll ...
return FReply::Unhandled();
```

The fix reads the origin **before** `SetCursorPos`, then reads back what Slate stored,
and builds the event from that real pair. The moves also now carry
`FSlateApplication::GetPressedMouseButtons()` instead of an empty set — which is the
*second* half, and the reason `SScrollBox`'s right-click drag scrolling failed with the
identical signature: it gates on `MouseEvent.IsMouseButtonDown(EKeys::RightMouseButton)`
as well as the delta.

Capture itself was never broken and is **not** faked: the press is routed through
`ProcessMouseButtonDownEvent`, the widget answers with
`FReply::Handled().CaptureMouse(AsShared())`, and Slate installs the captor. The fix
does not call any capture API. It only reports who holds it.

Not special-cased to scrollbars. Anything that needs capture + delta — sliders,
splitters, `OnDragDetected`/drag-and-drop (which needs travel across *several* move
events to clear `GetDragTriggerDistance()`), marquee selection — is fixed by the same
change.

## New response fields (this is how you judge, not by assuming)

| field | meaning |
|---|---|
| `cursor_delta_x` / `cursor_delta_y` | `FPointerEvent::GetCursorDelta` of the last move dispatched. **Zero means no movement-tracking widget can possibly have responded.** |
| `moves_delivered` | how many moves carried a non-zero delta. `0` on a drag means no gesture happened. |
| `mouse_captor` | type name of the widget holding pointer capture after the action, or `null`. |
| `captor_after_press` | drag only — who took capture in answer to the press. |
| `pressed_buttons` | Slate's held buttons after the action. |
| `steps_planned`, `total_travel_x/y` | drag only. |
| `handled_by` | scroll only — `slate` \| `game_viewport` \| `nothing`. |

---

## The experiments

Target: the Profile chronicle `ProseScroll` in Aphrosia (`WBP_CharacterPanel`), the
widget two critics wrongly failed. Open the character panel, Profile tab. Geometry of
record (2026-08-02): content 645.933 px, viewport 279.584 px, range 388.71 local px,
DPI 0.94247, scrollbar at desktop x ≈ 1424.6, track spanning roughly y 640–920.

Read the offset the same way every time, so the numbers are comparable:

```
object_get_property  { object: "<ProseScroll path>", property: "ScrollOffset" }
```

and confirm the range with `GetScrollOffsetOfEnd()` as the dossier did.

### 1. Wheel — the fix

```
editor_pie_mouse { action:"scroll", x:1300, y:780, delta:-3 }
```
(x/y are new: they place the cursor over the prose column first. `1300` is inside the
scroll viewport, not on the scrollbar.)

**PASS looks like:** `handled_by:"slate"`, and `ScrollOffset` moves from 0 to roughly
`3 × GetGlobalScrollAmount() × WheelScrollMultiplier` local px (order 100–300 with
engine defaults; the exact figure does not matter, a change from 0 does). `delta:+3`
afterwards must bring it back toward 0.

**FAIL looks like:** `handled_by:"game_viewport"` or `"nothing"` with `ScrollOffset`
unchanged — that is the old defect, i.e. the rebuild did not take.

### 1b. Wheel — POSITIVE CONTROL (must FAIL if the fix is absent)

Two controls, run both:

- **Sanity that the wheel is arriving at all, independent of the ScrollBox.** Close the
  panel. Read `CameraBoom->TargetArmLength` / the pawn's control rotation pitch, then
  `editor_pie_mouse { action:"scroll", x:960, y:540, delta:1 }`. The camera must move.
  On the OLD binary this left the camera **bit-identical** while
  `editor_pie_press_key("MouseScrollUp")` moved it (pitch −30 → −33.07, z 191 → 195.96)
  — that is the recorded failing measurement, and it must no longer reproduce.
- **Sanity that the ScrollBox is the thing consuming it.** Scroll with the cursor
  *outside* the panel (e.g. `x:200, y:200`) and confirm `ScrollOffset` does **not**
  change. If it moves, the wheel is not being hit-tested and the result above proves
  nothing.

### 2. Captured drag — the fix

Grab the scrollbar thumb (top of the track when offset is 0) and drag it down:

```
editor_pie_mouse { action:"drag", x:1424.6, y:660, to_x:1424.6, to_y:900, steps:12 }
```

**PASS looks like:**
- `captor_after_press: "SScrollBar"` — the press took capture;
- `moves_delivered: 12` (or however many `steps_planned` says — the two must match);
- `cursor_delta_y` non-zero, `total_travel_y ≈ 240`;
- `ScrollOffset` moves from 0 to a large fraction of `GetScrollOffsetOfEnd()` (388.71).

**FAIL diagnoses itself** with these fields, which is the point of adding them:
- `moves_delivered: 0` or `cursor_delta_y: 0` → the harness did not move the pointer.
  Still a harness bug; do not touch the widget.
- non-zero delta, `captor_after_press: ""` or `mouse_captor: null` → the press did not
  land on the thumb. Re-read the thumb's geometry from `editor_pie_widget_tree`; the
  drag is fine, the aim is not.
- non-zero delta **and** `captor_after_press: "SScrollBar"` **and** `ScrollOffset`
  unchanged → *now* it is the widget, and that is a real finding.

### 2b. Captured drag — POSITIVE CONTROL (must FAIL if the fix is absent)

The control is **the same gesture with the press removed**:

```
editor_pie_mouse { action:"move", x:1424.6, y:660 }
editor_pie_mouse { action:"move", x:1424.6, y:900 }
```

Two moves, identical travel, no button held. `ScrollOffset` must stay at 0 and
`mouse_captor` must be `null`. If this scrolls, capture is not gating anything and the
drag result is meaningless. Note that `cursor_delta_y` will be non-zero here — that is
correct and is itself the evidence that the delta fix works independently of capture.

Then the manual three-call form, which is what a caller actually reaches for and which
failed identically before:

```
editor_pie_mouse { action:"press",   x:1424.6, y:660 }   -> captor_after_press? mouse_captor?
editor_pie_mouse { action:"move",    x:1424.6, y:780 }   -> cursor_delta_y ≈ 120, mouse_captor "SScrollBar"
editor_pie_mouse { action:"move",    x:1424.6, y:900 }   -> cursor_delta_y ≈ 120
editor_pie_mouse { action:"release", x:1424.6, y:900 }
```

This one crosses MCP call boundaries, so the editor ticks between the press and the
moves. If the single-call `drag` passes and this fails, capture is being dropped between
calls — a *different* defect from the one fixed here, and `mouse_captor` on each move
localises it to the exact call where it was lost. Report that rather than re-opening
this fix.

### 3. Right-click drag scrolling — the independent corroborator

`ProseScroll` has `bAllowRightClickDragScrolling=True`. Drag on the *content*, not the
scrollbar:

```
editor_pie_mouse { action:"drag", button:"right", x:1300, y:850, to_x:1300, to_y:700, steps:12 }
```

This needs both halves of the fix — `SScrollBox::OnMouseMove` reads
`IsMouseButtonDown(EKeys::RightMouseButton)` *and* `GetCursorDelta()`, and accumulates
until it passes `FSlateApplication::GetDragTriggerDistance()`. It failed with the same
signature as the thumb drag before, from a completely independent code path. If the
thumb drag passes and this does not, the pressed-button half did not take.

### 4. Regression — nothing that used to work may stop

- `editor_pie_click_widget { match: "<some button>" }` still fires `OnClicked`
  (it shares `MoveCursorToPixel`, which changed).
- `editor_pie_mouse { action:"click" }` on a UMG button still works.
- Text entry: `editor_pie_click_widget` a field, `editor_pie_type_text`, check
  `characters_accepted_by_ui > 0`.
- Camera control with the wheel over the open world still works (that is experiment 1b's
  first control).

### 5. Automation tests

```
test_run { filter: "Hayba.MCP.PIE" }
```

`Hayba.MCP.PIE.DragPath` covers the pure arithmetic — that no planned drag step is a
sub-pixel no-op, that the path ends on the destination, and that the quantiser models
`FSlateUser::SetCursorPosition`'s `(int32)` cast. `Hayba.MCP.PIE.CoordinateSpace` is the
existing 24px-offset regression test.

The TypeScript side (`npx vitest run src/tools/pie/pie-tools.test.ts`, 44 tests, green
at time of writing) additionally asserts the *ordering* that constitutes the fix: that
`SendPointerMoveTo` reads the cursor position before `SetCursorPos`, that it never uses
`GetLastCursorPos` (poisoned after a move), and that it passes Slate's pressed buttons
rather than an empty set.

---

## What is still unverified after all of this

- Everything above. None of it has been run.
- Whether Slate mouse capture survives *between* MCP calls in a PIE viewport whose
  `MouseCaptureMode` is `CaptureDuringMouseDown`. Single-call `drag` does not depend on
  it; the press/move/release form does. Experiment 2b is what tells them apart, and
  `mouse_captor` is what localises it.
- The exact wheel scroll magnitude, which depends on `GetGlobalScrollAmount()` and the
  widget's `WheelScrollMultiplier`. Judge the wheel on *changed vs not changed*, not on
  a predicted number.
