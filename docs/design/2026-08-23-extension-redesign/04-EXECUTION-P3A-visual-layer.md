# P3a — the visual layer (execution plan)

**Why this first:** it is the only part of the redesign with *zero* collision
against the in-flight crash work. No crash issue (#406/#407/#411/#415/#387)
touches `HaybaMCPStyle.cpp` or `Resources/`. Landing it puts the new design
language in the live editor on the *existing* 11 tabs, weeks before the IA
rewrite (P3b) is unblocked — and answers the one question no review sheet can:
**do these icons hold at 28px in real Slate chrome?**

Scope discipline: P3a changes how things LOOK. It does not rename, merge, or
delete a single panel. That is P3b.

---

## Step 1 — Icon pipeline: PNG at 2×

### The decision
`icons-final/` holds 512px PNGs. The style set currently declares everything
with `IMAGE_BRUSH_SVG` (`HaybaMCPStyle.cpp:66-86`). Three options were on the
table; **ship PNG at 2×**:

| Option | Verdict |
|---|---|
| **PNG at explicit 2× sizes** | **Chosen.** Works today, no tracing artefacts, exact control of what each size looks like. Cost: two files per icon, no free DPI scaling beyond 2×. |
| Auto-trace to SVG | Rejected for now — tracing organic AI shapes yields hundreds of bezier points and muddy curves; the crispness win is theoretical. |
| Hand-trace the 6 sidebar icons | Deferred. This is the *upgrade path* if 28px PNG disappoints in-editor (see Step 5). |

### Work
1. Generate two rasters per icon from the 512px master:
   `Resources/Icons/<name>@28.png` (28×28) and `<name>@56.png` (56×56) for the
   sidebar tier; `<name>@16.png` / `<name>@32.png` for the inline tier.
   Downsample with a proper filter (Lanczos), not nearest.
   Only the icons a surface actually uses need both tiers — start with the 6
   sidebar nouns + 3 state marks + the ~8 used in Activity rows.
2. Keep the 512px masters in `docs/design/.../icons-final/` as the source of
   truth. `Resources/Icons/` holds only derived rasters.
3. Add a tiny generator script (`tools/build-icons.mjs` or a PowerShell
   equivalent) so re-deriving is one command when an icon changes. Do not
   hand-resize.

### Brush declaration
`IMAGE_BRUSH_SVG` → `IMAGE_BRUSH` for the new set, with the size matching the
raster exactly so Slate does no scaling:

```cpp
Style->Set("Hayba.Icon.World",  new IMAGE_BRUSH(TEXT("Icons/world@28"),  FVector2D(28.f, 28.f)));
Style->Set("Hayba.Icon.World.S", new IMAGE_BRUSH(TEXT("Icons/world@16"), FVector2D(16.f, 16.f)));
```

**The logo stays `IMAGE_BRUSH_SVG`** — it is real vector art and must keep
scaling cleanly at every size. Do not touch `HaybaLogo.svg` or its four
brush entries.

---

## Step 2 — The token layer in `FHaybaMCPStyle`

Today: 6 text styles, 12 icon brushes, and **53 inline `FLinearColor` literals
scattered across 9 panels** (ToolStream 22, SceneMap 8, Capabilities 6,
Settings 5, Chat 4, MainPanel 3, Validation 3, Diff 1, Plan 1). Plus
`FAppStyle::Get()` used ~100× where Hayba tokens should apply.

Add to `Create()`, named exactly as `palette.md`:

```
Hayba.Color.Surface.Panel    #20252B      Hayba.Color.Text.Primary    #E5E9ED
Hayba.Color.Surface.Raised   #292F36      Hayba.Color.Text.Secondary  #AAB3BD
Hayba.Color.Surface.Sunken   #171B20      Hayba.Color.Text.Muted      #77828E
Hayba.Color.Border.Subtle    #3A424B      Hayba.Color.Accent.Ochre    #C47A28
Hayba.Color.Border.Strong    #515B66      Hayba.Color.Accent.Hover    #D88A30
Hayba.Color.Status.Pass      #7EA58A      Hayba.Color.Accent.Pressed  #A96520
Hayba.Color.Status.Fail      #C46E68
```

Plus metric tokens so spacing stops being magic numbers:
`Hayba.Metric.Radius.{Chip=6,Card=8,Panel=10}`,
`Hayba.Metric.Pad.{XS=4,S=8,M=12,L=18,XL=28}`,
`Hayba.Metric.Icon.{Inline=16,Sidebar=28}`.

**Sweep order** (one commit per panel, easy to review and revert):
ToolStream (22) → SceneMap (8) → Capabilities (6) → Settings (5) → Chat (4) →
MainPanel (3) → Validation (3) → Diff (1) → Plan (1).

Guard it: a `scripts/` lint that fails on a new `FLinearColor(` literal inside
`Private/*Panel.cpp` (allowlist the few genuinely one-off cases). Per
ADR-0007, teach the guard every call form in the same commit.

---

## Step 3 — The ochre rule, enforced

`#C47A28` may appear only for: active destination, pending approval, unsaved
edit, rule needing attention. Anything else is a bug.

- Add the rule to `CONTRIBUTING.md`.
- A `scripts/` check: grep for the ochre token in Slate code and require each
  use to sit in an allowlisted context. Cheap, and it is the difference
  between a system that holds and one that erodes in three months.

---

## Step 4 — Row-level state (no badges, ever)

Per your decision: no dot or badge composited on an icon.

- **Active** = `Surface.Raised` + a 3px ochre inset edge on the row. Icon
  geometry unchanged.
- **State** = a 15–16px mark (`state-attention` / `state-pending` /
  `state-unsaved`) in a **right-aligned slot at the end of the row**, which is
  where Unreal's own dirty markers live, so it reads as native.
- Inline contexts (status chips, Activity verdict rows) use the same three
  marks at the same size next to text.

This lands in the *existing* MainPanel sidebar without renaming anything —
it is a rendering change, not an IA change.

---

## Step 5 — The verdict pass (the actual point of P3a)

With the plugin rebuilt, look at the real editor and judge:

1. Do the 6 sidebar nouns read at 28px against Unreal's chrome?
2. Do the three state marks survive at 15px — especially the hourglass, whose
   internal sand/trickle detail is the highest-risk element in the set?
3. Does ochre-only-for-meaning actually feel right, or does the UI read flat?

**If 28px disappoints:** the upgrade path is already scoped — hand-trace only
the 6 sidebar icons to clean SVG (a day of vector work), keep PNG for
everything else. Do not re-run image generation; the shapes are signed, only
the rendering fidelity would be in question.

Capture before/after screenshots of the sidebar for the R4 evidence page.

---

## Definition of done

- 37 icons deriving to `Resources/Icons/` from one script.
- Zero `FLinearColor` literals in panel files (or allowlisted with a reason).
- Sidebar shows active + state without any icon badge.
- A lint guarding both the literals and the ochre rule.
- Screenshots taken; the 28px verdict recorded in this file.
- **No panel renamed, merged, or deleted** — P3b remains untouched and still
  gated on R1.
