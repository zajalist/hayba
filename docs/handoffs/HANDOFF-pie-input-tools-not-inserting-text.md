# Handoff: PIE input tools don't insert text into UMG EditableTextBox

> **RESOLVED 2026-07-30.** Cause: `editor_pie_type_text` dispatched through
> `UGameViewportClient::InputChar` and `editor_pie_press_key` through
> `InputKey`. Both feed the GAME input pipeline, which never consults the Slate
> widget tree, so a focused `SEditableText` never saw them. This is the same bug
> the mouse path already fixed once — `SendMouseButton` carries a comment
> explaining it; the keyboard paths were never moved over. Characters now go
> through `FSlateApplication::ProcessKeyCharEvent` and keys through
> `ProcessKeyDown/UpEvent`, with the viewport kept as the fallback for anything
> the UI declines, so gameplay bindings are unchanged.
>
> Verified live against this exact repro: `click_widget {match:"Username"}` →
> `type_text {"zejbadr"}` → screenshot shows **zejbadr** in the field.
> `press_key Tab` moves focus (typing then lands in Password), and
> `press_key BackSpace` erases a character.
>
> A second cause sat behind the first: Slate's text layout keys backspace and
> submit off the CHARACTER event (`'\b'`, `'\r'`), not the key event. The
> platform sends both; a synthetic key-down alone reported success and erased
> nothing. `press_key` now sends the companion character for those two keys.
>
> The responses were also lying by omission, which is why this went unnoticed:
> `characters_sent` and `dispatched` only ever meant "we tried".
> `type_text` now returns `characters_accepted_by_ui`, `press_key` returns
> `handled_by_ui`, and both return `focused_widget`. That paid off during
> verification itself — a click that silently focused the `SViewport` instead of
> the text field was visible immediately as
> `{focused_widget:"SViewport", handled_by_ui:false}`.
>
> Guarded by tests in `pie-tools.test.ts`, since this routing mistake has now
> shipped twice in this file and nothing about the viewport call looks wrong at
> the call site. The two bugs below are unfixed — see the notes on each.

**Date:** 2026-07-30
**Found by:** live-driving Aphrosia's character UI via the new PIE automation commands (`editor_pie_mouse`, `editor_pie_type_text`, `editor_pie_press_key`, `editor_pie_click_widget`, `editor_pie_widget_tree`, `editor_pie_screenshot`) added to `HaybaMCPPIEHandler`.
**Context:** These tools are otherwise a huge win — screenshot+click-by-text let me drive the actual game loop end to end (open panel → select character → confirm modal → verify rendered data) with real evidence instead of guessing. This one gap blocks the rest.

## Bug: `editor_pie_type_text` reports success but inserts nothing

Repro (Aphrosia's login screen, `WBP_StartScreen` or similar — an `SEditableText` inside a UMG `EditableTextBox`):

1. `editor_start_pie` → wait ~15s for the level to fully render (see second bug below).
2. `editor_pie_mouse {action: click, x: 958, y: 552}` — clicks directly on the Username field. Screenshot confirms a visible focus/highlight border appears on the field.
3. `editor_pie_type_text {text: "zejbadr"}` → returns `{"characters_sent": 7}`.
4. Screenshot: field still shows the placeholder text "Username" — **zero characters landed**.

Retried with a cleaner focus path to rule out a bad click coordinate:

1. `editor_pie_click_widget {match: "Username"}` → returns `clicked_type: "SEditableText"`, `clicked_text: "Username"`, `target_interactive: true`, `candidates: 8` — so it found and clicked the exact right widget, not a decoy.
2. `editor_pie_type_text {text: "zejbadr"}` → same `characters_sent: 7` success report.
3. Screenshot: still just the placeholder, field still shows a focus ring but no typed text.

Also tried `editor_pie_press_key {key: "Z", event: "pressed_and_released"}` after focusing the field the same way — same result, no character appears.

**So:** focus is definitely landing on the right `SEditableText` (confirmed visually + by widget type in the response), but neither the character-event path (`type_text`) nor the raw-key path (`press_key`) actually produces a visible character in the box. Both report `dispatched`/`characters_sent` success, which makes this a "silent lie" per your own README wording — the response claims something happened that didn't.

**Guess at cause (unverified):** `UEditableTextBox`/`SEditableText` may require the character event to go through `FSlateApplication::Get().ProcessKeyCharEvent` with a widget-path-scoped delivery (not just "whatever has keyboard focus" at the `FSlateApplication` level), or the PIE viewport's input processor isn't in the delivery chain UMG expects for IME/text commit. Might also be that `GVC->InputKey` (used by `press_key`) never synthesizes the corresponding `OnKeyChar` the way real OS input does — Slate normally gets both a key-down AND a char event from the platform layer, and this only injects one of them.

**Impact:** blocks fully-autonomous PIE QA on any screen with a text field (login, chat, search boxes, the character-creation wizard's name/description fields). I worked around it for this session by getting PIE to boot directly past the login screen (a debug-only C++ fallback in the game's `AphrosiaGameMode::ResolveConnectionIdentity`), but that's a one-off workaround specific to this project, not a fix.

**Suggested verification once fixed:** repeat the exact repro above (click Username via `click_widget`, `type_text: "zejbadr"`, screenshot) and confirm the literal string appears in the field.

---

## Bug (probably a symptom, not new): PIE renders solid black for 10-20+ seconds after `editor_start_pie`, with no error logged

Observed across several `editor_start_pie` calls in the same session: `editor_pie_screenshot` returns a valid, correctly-sized PNG that is **just solid black** — not a capture-timing artifact of the async two-call protocol (I `check_only`-polled until `captured: true` before reading it). No shader-compile log lines, no D3D/TDR errors, nothing in `Saved/Logs/*.log` explaining it. Waiting ~15s and retrying the same `editor_pie_screenshot` call against the same still-running PIE session produced a correct, fully-rendered frame.

This got worse — multiple full-black minutes, one editor process exit — when another Claude session was concurrently rebuilding/relaunching the same editor process. That concurrent-access thrashing may be the dominant cause rather than a bug in the screenshot/PIE-start commands themselves, but flagging in case there's also a real "first frame(s) after PIE start can render black with no warning" issue worth a `wait_for_render_ready`-style guard before the first screenshot is trusted.

---

## Confirmed working well in this same session (for context, not bugs)

- `editor_pie_screenshot`'s new async `request` → `check_only:true` poll protocol works correctly and was reliable once the render itself wasn't black.
- `editor_pie_mouse` (click) correctly drives real UMG button clicks — used it to open a HUD panel, click a character portrait, and click Confirm on a modal dialog, all verified via screenshot.
- `editor_pie_click_widget` matching by visible text works well and is a much better primary tool than coordinate-guessing — its `candidates` count and "prefers interactive" behavior are exactly right.
- `editor_pie_widget_tree` (optionally with `filter`) is exactly what's needed to locate on-screen elements before clicking; would be good to also expose a "no truncation, give me everything matching" mode since the default response silently truncates (`_truncated` block is present but easy to miss when scanning for a specific widget count).
