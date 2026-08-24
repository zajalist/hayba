# Hayba extension — wireframe brief

## What this is
An Unreal Engine 5 editor plugin panel (Slate), docked in the editor. An AI
agent authors 3D worlds through it. We are collapsing 11 implementation-named
tabs into 5 intent-named ones.

## What it is today (the problem)
Sidebar has 11 tabs: Chat, MCP, Slivers, Tool Stream, Scene Map, Plan, Diff,
Validation, Library, Lessons, Settings. They are named after the systems that
implement them, not after what a user wants. A user with ONE question has to
know which of three tabs holds the answer:
- "what is the agent doing / did it?"  -> Plan + Diff + Tool Stream
- "what must be true, and why?"        -> Validation + Lessons + a PLUMB panel
- "what can I use?"                    -> Library + Slivers
- "configure"                          -> MCP + Settings

## The new model (decided — build to this, do not redesign it)

Spine: **everything is an edit to one understood world.**

Five nouns. Settings is a gear, not a sidebar peer.

| Noun         | Is |
|--------------|----|
| **World**    | the understood scene — spatial grounding, cognitive map of actors/regions |
| **Library**  | everything you can place or apply: **Profiles** (what an asset IS — baked geometry + semantics) and **Recipes** (a parameterized, repeatable edit) |
| **Rules**    | what must be true. One closed set of 13 constraint primitives. Each rule carries its **Lesson** (the why) inline — lessons are NOT a separate screen |
| **Activity** | ONE timeline: proposed -> executing -> done, with before/after and undo inline |
| **Chat**     | how you ask |

## The single most important interaction

Rules must never be a place you go. Running a Recipe shows its verdict inline,
at the moment of the edit. Verdicts are **directional**: each constraint yields
a signed margin in metres plus a fix vector, so the UI can offer a real
[Fix] button that moves the object the right way — not a red X.

An Activity row therefore shows, together:
  the Recipe that ran, the Rules it was checked against, each rule's signed
  margin, a [Fix] affordance on violations, the instance count, a
  before/after toggle, and an undo.

That co-location is the whole design. If the wireframes lose it, they fail.

## Screens to wireframe

1. **Activity** (the default/home screen — most-used)
   - reverse-chronological rows, newest at top, live row streaming at top
   - a row collapses to: title, source (Recipe / Chat / direct tool), status,
     duration. Expands to: rule verdicts w/ signed margins, counts,
     before|after, undo, "Save as Recipe"
   - a row awaiting approval (Plan Mode) is a distinct state: it shows the
     proposed steps and [Approve] / [Reject] inline. Plan is a STATE of an
     activity row, not a separate screen.
   - filter/search across tool name, params, result

2. **Chat**
   - conversation, streaming responses
   - tool calls appear as compact inline cards that link to their Activity row
   - session list / persistence (today chat sessions do NOT persist — design
     for that being fixed)

3. **World**
   - a 2D cognitive map of the scene: actors, regions, relationships
   - selecting a node cross-highlights in the real UE viewport
   - shows what the agent actually understands, and — important — what it
     does NOT (unprofiled assets, ungrounded regions) so the user can see gaps

4. **Library**
   - two sections: Profiles and Recipes
   - a Profile card: the asset, its baked bounds/semantics, which rules bind
     to it, "Open in Studio"
   - a Recipe card: what it does, its parameters, last run, [Run]
   - Recipes are usually CAPTURED, not authored: an Activity row offers
     "Save as Recipe", which lifts varying values to parameters and opens a
     review sheet BEFORE anything is saved. Wireframe that review sheet.
   - empty states matter: on a fresh install the user may have chosen not to
     seed presets. Design the empty state to teach the capture flow.

5. **Rules**
   - the library of bound constraints, grouped by what they bind to
   - each rule: its primitive, its numbers, what it binds to, its Lesson
     (the why) inline and collapsible, and how often it has fired
   - authoring is FILL-IN-THE-BLANKS only: you pick one of 13 fixed
     primitives and fill numbers. There is no expression language, no
     operators. The UI must make that constraint feel like a feature
     (safety, no broken logic) rather than a limitation.

6. **Settings** (gear / modal, not a sidebar tab)
   - connection, AI backend, sidecar, plan mode, and the tool-capability
     toggles that used to live in the "MCP" tab

7. **First-run wizard**
   - today it is a checklist that says "7 panels" (wrong — there were 11) and
     ends on a step reading "Coming soon."
   - redesign: required steps (connection, capability token, plan mode) then
     optional, INCLUDING an explicit "seed my Library with a few starter
     Recipes?" choice. Nothing may say "coming soon".

## Constraints
- Dark UI. It lives inside Unreal's dark grey editor chrome and must not fight it.
- Slate-buildable: rows, boxes, scroll boxes, expandable areas, splitters.
  No CSS grid gymnastics that cannot be expressed in Slate.
- Panel is often DOCKED AND NARROW (~380px) as well as wide. Show both.
- Use the palette and icons from the sibling visual-system work if present in
  `docs/design/2026-08-23-extension-redesign/` (palette.md, icons/). If absent,
  use cool neutral dark surfaces with `#B56A1D` ochre reserved strictly for
  meaning: active, pending, violated, unsaved.

## Deliverable
A single self-contained `wireframes.html` in
`docs/design/2026-08-23-extension-redesign/` — dark, no external assets, no CDN.
All 7 screens, each labelled, plus the narrow-dock variant of Activity and
Chat. Annotate with short callouts explaining intent where a layout choice is
load-bearing. Wireframe fidelity: mid — real layout and hierarchy, real
example content (Unreal-flavoured: landscapes, PCG biomes, foliage, WBP
widgets), but no pixel-perfect chrome.

Also write `IA.md`: the tab list, what merged into what, and what was DELETED.
