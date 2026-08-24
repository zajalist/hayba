# Hayba extension redesign — information architecture

## Product spine

Hayba is an editor companion for making one understood 3D world. The primary question is not “which implementation subsystem do I need?” but “what do I want to understand, place, change, or verify?”

The dock has five intent-named sections. Settings is a gear action in the chrome, not a peer destination. Rules are a library of reusable constraints, but their verdicts are rendered inline in Activity at the moment an edit runs.

```text
Hayba
├── Activity        default / home: proposed → executing → done
│   ├── live activity row
│   ├── approval state (Plan Mode)
│   ├── expanded verdicts + signed margins + Fix
│   ├── before / after + viewport link
│   └── undo / Save as Recipe
├── Chat            ask the agent; persistent sessions
├── World           cognitive map of understood scene + gaps
├── Library
│   ├── Profiles    what an asset is: bounds + semantics + bindings
│   └── Recipes     parameterized, repeatable edits
├── Rules           bound constraint library + inline Lessons
└── Settings        modal: connection, backend, sidecar, Plan Mode, capabilities
```

## Navigation model

| Destination | User intent | Entry state | Leaves when |
|---|---|---|---|
| Activity | “What is the agent doing or did it do?” | newest activity visible; live row open | user opens a different destination or the current row |
| Chat | “Ask for a change or explanation.” | current session and composer | user follows an Activity link or changes section |
| World | “What does the agent understand?” | fitted cognitive map | user selects a node or navigates away |
| Library | “What can I place or apply?” | Profiles and Recipes sections | user opens Studio or runs a Recipe |
| Rules | “What must be true, and why?” | grouped bound constraints | user adds/edits a fixed primitive |
| Settings | “Configure the connection and permissions.” | modal over current screen | save or cancel |

The current Slate implementation has a resizable left sidebar and a compact header. The redesign preserves that spatial contract: five labeled items remain usable when expanded, and the sidebar can collapse to icon-only controls with tooltips. The content area remains a dockable editor panel rather than a full-screen web app.

## Activity is the integration point

Every consequential action becomes one row in a reverse-chronological timeline. A row is intentionally richer than a log entry:

1. Collapsed: title, source (`Recipe`, `Chat`, or direct tool), status, duration, timestamp.
2. Expanded: proposed/executed steps, rule verdicts, signed margin in metres, fix affordance, instance counts, before/after, viewport link, undo, and `Save as Recipe` when the edit is complete.
3. Live: same row structure, but progress and verdicts update as instances land. The latest row is expanded by default.
4. Approval: a distinct pending state with proposed steps and inline `Approve` / `Reject`. Plan Mode is a row state, not a screen.

The directional verdict contract is the key interaction rule:

```text
pass      ✓  +1.8 m     satisfied
attention ↗  -0.6 m     [Fix →] moves the object along the returned fix vector
```

Never represent a violation as only a red X. The user needs the amount, the direction, and an available next action.

Activity inherits the useful affordances from the current tool stream panel: a search field over tool name/params/result, expandable groups, timestamps, colored domain/status chips, compact params/result previews, Stats, copy, archive, and clear. The redesign changes the grouping from implementation turns to user-meaningful activity transactions and adds rule evidence and undo.

## Library model

Profiles and Recipes are siblings, not mixed card types.

- A Profile describes what an asset is: baked bounds, semantic labels, bound Rules, and `Open in Studio`.
- A Recipe describes a repeatable edit: purpose, parameters, last run, and `Run`.
- Running a Recipe creates an Activity row; it does not jump to a hidden execution panel.
- Capturing is the normal authoring path. `Save as Recipe` opens a review sheet before persistence.
- The review sheet shows the captured action, proposed name/description, lifted parameters, fixed values, bound rules, and a preview of what future runs will affect. The user can rename, adjust which values become parameters, then confirm `Save recipe`.
- A fresh install with no seeded presets has a teaching empty state: run any edit, then capture it from Activity. It does not pretend that a future screen is “coming soon.”

## Rules model

Rules are authored with fill-in-the-blanks only:

```text
primitive → number(s) → binding → human name
```

There is no expression language, custom operator, or hidden logic editor. The UI should make the fixed set of 13 primitives feel like a safety guarantee: every rule is inspectable, bounded, and able to return a signed margin plus fix vector.

Each Rule card contains its primitive, numbers and units, binding, inline collapsible Lesson, and fire count. Grouping is by what the rule binds to (spatial relationships, regions, actors, etc.), with search across names, bindings, and Lessons.

Rules remain discoverable here for maintenance, but the operational verdict belongs to Activity. A user should not have to leave the edit to understand why it failed.

## World model

World is a 2D cognitive map, not a replacement for Unreal’s viewport. It shows:

- actors and regions the agent knows about;
- relationships such as spatial links and containment;
- selected-node cross-highlighting in the real UE viewport;
- gaps: unprofiled assets and ungrounded regions.

Unknowns are first-class visual states. The map must make uncertainty visible instead of presenting an overconfident complete scene.

## Chat model

Chat is the asking surface, not an execution surface. Responses stream in place. Tool calls appear as compact inline cards with a stable link to their Activity row, where the full evidence lives. Sessions persist and can be reopened; a new session is explicit. This corrects the current non-persistent chat assumption without splitting conversation history from the work it caused.

## Settings and first run

Settings is a modal so configuration does not compete with the five nouns. It owns connection, AI backend, sidecar health, Plan Mode, and the capability toggles formerly exposed under MCP.

The first-run wizard is an ordered setup flow:

1. Required: connection.
2. Required: capability token / tool capabilities.
3. Required: Plan Mode / approval behavior.
4. Optional: seed the Library with starter Recipes.

The optional seed choice must be explicit. The wizard never says “7 panels,” “11 panels,” or “Coming soon.” When the user postpones setup, the current workspace remains visible and the unfinished requirement is recoverable from the First run entry or Settings.

## State vocabulary

Use one consistent status set across Activity, inline Chat cards, and Library run results:

- `running` — work is streaming; blue-neutral status.
- `needs approval` — Plan Mode pause; semantic ochre.
- `done` — completed; restrained green.
- `needs attention` — a rule has a negative margin; semantic ochre plus `Fix`.
- `error` — tool or connection failure; restrained red, with the returned error text.

Ochre is reserved for meaning: active destination, pending approval, unsaved capture, or a rule needing attention. It is not decorative branding. The existing Hayba logo remains unchanged beside the neutral Slate chrome.
