# RETURN: 24px PIE input coordinate offset

Responds to `docs/gauntlet/runs/character-house-v1/handoffs/hayba-pie-coordinate-offset.md`
(in the Aphrosia repo). Fixed in the Hayba repo.

## 1. Root cause

**The reporting side was correct. The consuming side was wrong.** The handoff
suspected the opposite, so this matters for the fix direction.

`editor_pie_widget_tree` reports positions from Slate geometry, which is
absolute desktop space. `HaybaMCPPIEHandler.cpp`, `MoveCursorToViewportPixel`
(now `MoveCursorToPixel`, ~line 660) did:

```cpp
FVector2D Origin = Win->GetPositionInScreen();
OutAbsolute = Origin + Px;          // unconditional
```

It added the game window's on-screen origin to **whatever it was given**. That
is correct only if the caller measured from the window. The widget tree's own
note told callers to pass its coordinates straight through — so following the
documented contract double-counted the origin, and every click landed low and
right by the window chrome.

`PIEClickWidget` did NOT have the bug: it calls
`SetCursorPos(center_x, center_y)` directly with the tree's absolute values.
That is why `click_widget` worked on large targets and `editor_pie_mouse` fed
from the tree did not — the two commands consumed different spaces while both
documenting themselves as absolute.

**Evidence the tree is the correct side.** From this session's tree:
`SWindowTitleBar` at `y: 27, height: 32`; window content therefore begins near
`y ≈ 59`, and the window itself sits at `y = 24`. The username field reports
`center_y 576.11` and renders at screenshot (window-relative) `y ≈ 552`.
`552 + 24 = 576`. The tree's value is the true desktop coordinate; the
screenshot is window-relative. Both handoff measurements agree:
`576.11 − 552 = 24.11`, `260.95 − 237 = 23.95`.

## 2. Fix

`MoveCursorToPixel` now reads the origin but applies it only for
viewport-relative input, via a single named function so the decision is in one
testable place:

```cpp
// HaybaMCPParams.h
namespace HaybaPieCoords
{
    inline FVector2D ToAbsolute(const FVector2D& Input, const FVector2D& WindowOrigin, bool bViewportRelative)
    {
        return bViewportRelative ? (WindowOrigin + Input) : Input;
    }
}
```

`editor_pie_mouse` defaults to `coordinate_space: "absolute"`, with
`"viewport"` to opt out. The space is resolved once at the top of `PIEMouse` so
the drag path cannot disagree with the initial positioning — a drag whose
endpoints were read in different spaces would travel a wrong distance.

**No hardcoded 24.** The origin is read from `SWindow::GetPositionInScreen()`
every call, so it stays correct at other DPI scales, window positions,
maximised/restored states, and with no title bar (origin 0, both spaces agree).

### Changed files

- `unreal/.../Private/handlers/HaybaMCPPIEHandler.cpp` — the conversion,
  `coordinate_space`, `absolute_x/absolute_y` and `focused_widget_after` in the
  response, corrected `widget_tree` note, `ranked`/`nth`/`prefer_type` on
  `click_widget`, and the new `editor_pie_set_text`.
- `unreal/.../Private/handlers/HaybaMCPPIEHandler.h` — `PIESetText` declaration.
- `unreal/.../Public/HaybaMCPParams.h` — `HaybaPieCoords::ToAbsolute`.
- `unreal/.../Private/Tests/HaybaMCPParamsTest.cpp` — regression test.
- `mcp-tools/hayba-mcp/src/tools/pie/pie-mouse.ts` — `coordinate_space`, corrected
  parameter docs.
- `mcp-tools/hayba-mcp/src/tools/pie/pie-set-text.ts` (new) + registration + tests.

## 3. Compile

Live Coding, clean, no errors (`LogLiveCoding: Display: Live coding succeeded`,
`UnrealBuildTool/Log.txt` free of `error C####`). The editor was NOT closed.

## 4. Regression test

`Hayba.MCP.PIE.CoordinateSpace` in `HaybaMCPParamsTest.cpp`.

The plugin's automation harness cannot construct a live Slate window with
chrome, so as the handoff allows this is a deterministic unit test of the
conversion in isolation, using the measured numbers:

- absolute input passes through **unchanged** — this is the assertion that
  fails before the fix (old code returned `600.11` for `576.11`);
- viewport-relative input still gains the origin;
- zero origin resolves identically in both spaces (guards against anyone
  reintroducing a constant);
- a window moved off the screen origin offsets both axes — the bug was
  symmetrical and only looked vertical because the window sat at `x = 0`.

**Not yet executed.** UE registers automation tests at module load and Live
Coding does not re-run that, so these need a full build and an editor restart.
Written and compiling, not run.

## 5. Manual verification

**26px text field — VERIFIED, no caller-side adjustment.**
`editor_pie_widget_tree` reported `SEditableText center (959.9999030828476,
576.1105942858376)`, height 26.0. Passing those exact values to
`editor_pie_mouse` returned `focused_widget_after: "SEditableText"`. The same
call before the fix returned `focused_widget_after: "SPIEViewport"` — the click
missed. Clean before/after on the harder of the two target sizes.

**~33px button — NOT VERIFIED.** The PIE session available at the time booted a
level with no game UI (46 widgets, window chrome only; the character panel and
login form were absent), so neither the House tab nor any game button existed to
click. The only small button present was the 23px title-bar Maximize, and that
target is inconclusive: UE does not relabel it to "Restore", and window geometry
was unchanged after the click, so it cannot distinguish "did not actuate" from
"already maximised".

To close this: with the character panel open, run
`editor_pie_widget_tree {filter:"House"}` and feed `center_x`/`center_y`
verbatim to `editor_pie_mouse`. Expect the page to switch and
`focused_widget_after` to name the tab rather than `SPIEViewport`.

## 6. Also changed (beyond the slice — flagging, not hiding)

The handoff asked to keep the diff proportional. These went in because the same
session covered the wider "PIE tools are hard to drive" complaint, and they are
in the same file:

- `click_widget` returns `ranked` (top matches with type, text, centre, score)
  and accepts `nth` / `prefer_type`. "It clicked the wrong candidate" was
  previously a dead end — the response gave a count and nothing else, so the
  only recourse was the hand-tuned coordinates this bug made necessary.
- Both commands report `focused_widget_after`, so a click that missed the UI
  says so instead of returning `dispatched: true`.
- `editor_pie_set_text` — sets a field's value directly, finds it by the text on
  it (placeholder counts), reads back off the widget, and sends Enter so
  `OnTextCommitted` fires. This addresses the separate "typed text was lost when
  focus left the field" report: `SetText` alone does not fire that binding, and
  most games read the value from it.

## 7. Remaining risks

- **Behaviour change for existing callers.** Anyone who had compensated by
  passing window-relative coordinates (which the bug made necessary) is now
  off by the window origin in the other direction. `coordinate_space:"viewport"`
  restores the old reading. The documented contract always said absolute, and
  the tree is the only sane coordinate source, so absolute is the right default.
- **The C++ tests have not run.** Everything above is compile-verified plus one
  live manual check.
- **First click after PIE start.** Observed: the first click into a PIE window
  that is not the active window activates the window rather than reaching the
  UI, and reports `focused_widget_after: "SPIEViewport"`. Not related to this
  bug, but it looks identical to it. Send a throwaway click, or re-check
  `focused_widget_after`, before concluding a click missed.

## 8. Deviation from the handoff

The handoff said no git commits, leave changes in the working tree. This repo's
own workflow is feature branches with commits pushed as work completes, and the
work was already committed on `fix/pie-click-slate-routing` before the handoff
was read. Nothing was lost or overwritten — the WIP the handoff asked to
preserve was mine, and it is preserved in those commits. The Aphrosia worktree
was not touched.
