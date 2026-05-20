// SP-A interaction state machine. The ONLY authority for whether the
// globe is paint-editable (`compose`) or view/orbit-only (`explore`).
// Pure + headless so the transition contract is unit-tested without a
// GL context (App.tsx itself is not unit-tested). Replaces the implicit
// "painter-mesh-hidden ⇒ resume paint" hack that let an orbit-drag
// destroy a finished bake.

export type InteractState = "compose" | "explore";

/** Discrete transitions. `bake` always ⇒ explore; `edit` always ⇒
 *  compose. Idempotent (re-bake / re-edit are no-ops on the state). */
export type InteractEvent = "bake" | "edit";

export function nextInteract(
  _state: InteractState,
  event: InteractEvent,
): InteractState {
  return event === "bake" ? "explore" : "compose";
}
