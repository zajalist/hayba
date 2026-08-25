# Colour migration — every inline literal, classified

Audit of all **54 inline `FLinearColor` literals across 9 Slate panels**,
2026-08-24. This is the table P3b works from; the call sites are deliberately
not changed yet, because most of these panels are rewritten by that pass and
editing them twice is churn.

The useful finding is not the count. It is that the literals are **four
different kinds of thing** that happen to share a type, and treating them
uniformly — which a naive "replace literals with tokens" sweep would do —
would destroy two of them.

## 1. Five places independently invented the same amber

These sit within 25° of the semantic ochre, and in every case **the meaning is
right and only the value is hand-rolled**. That is the strongest possible
evidence the ochre token is the correct abstraction: five authors, working
separately, reached for amber to mean exactly what it now means.

| Site | Literal | Means | Becomes |
|---|---|---|---|
| `HaybaMCPSettingsPanel.cpp:118` | `1.00, 0.78, 0.30` | `bIsDirty` — unsaved edit | `Accent.Ochre` |
| `HaybaMCPSettingsPanel.cpp:568` | `0.85, 0.55, 0.35` | "No key stored" — needs action | `Accent.Ochre` |
| `HaybaMCPValidationPanel.cpp:32` | `1.00, 0.85, 0.20` | severity Warning | `Accent.Ochre` |
| `HaybaMCPToolStreamPanel.cpp:329` | `1.00, 0.78, 0.30` | "N turns selected" — active state | `Accent.Ochre` |
| `HaybaMCPToolStreamPanel.cpp:35` | `1.00, 0.78, 0.30` | category: Scene | **`Cat.Scene`** — see §2 |

Migrating these is not a refactor, it is the token doing its job.

While there: `ValidationPanel.cpp:31` (`1.0, 0.3, 0.3`, severity Error) becomes
`Status.Fail`, and `:33` (`0.7, 0.7, 0.7`, default) becomes `Text.Secondary`.

## 2. Two categorical families, not one

A naive sweep would have folded these into greys and destroyed the information
they carry. There are **two independent categorical palettes**, and they need
to stay independent — a Tool Stream renderer type and a Scene Map node type are
different axes and should not share a colour by accident.

**Family A — Tool Stream renderer types** (`ToolStreamPanel.cpp:34-43`).
Retokenised in the previous commit as `Hayba.Color.Cat.*`. Two of its ten hues
had to move: Performance sat **1.5°** from the ochre and Scene **9.6°**, so two
ordinary categories read as "needs attention". Actor and Plan were 7.6° apart,
which is not a distinction anyone can make.

**Family B — Scene Map node semantics** (`SceneMapPanel.cpp:211-223`), found by
this audit and **not yet tokenised**:

| Semantic | Literal | Issue |
|---|---|---|
| Foliage | `0.30, 0.70, 0.40` | — |
| Building | `0.55, 0.60, 0.75` | reads as chrome grey, not a category |
| Light | `1.00, 0.85, 0.35` | **14.6° from the ochre** |
| Trigger | `0.35, 0.75, 1.00` | — |
| Character | `1.00, 0.45, 0.45` | collides with `Status.Fail` |
| Blueprint | `0.70, 0.50, 1.00` | — |

Three defects: Light reads as "needs attention", Character reads as an error,
and Building is desaturated enough to read as inactive chrome. This family
should get `Hayba.Color.Node.*` tokens on the same construction as Family A —
≥25° clear of the ochre, ≥30° apart, one shared saturation and value.

## 3. Eleven greys for six tokens

| Distinct grey in use | Nearest token | Drift |
|---|---|---|
| `0.50, 0.52, 0.60` | Text.Muted | close |
| `0.55, 0.57, 0.65` | Text.Muted | loose |
| `0.60, 0.60, 0.70` | Text.Secondary | loose |
| `0.60, 0.62, 0.72` | Text.Secondary | close |
| `0.65, 0.65, 0.70` | Text.Secondary | close |
| `0.70, 0.70, 0.70` | Text.Secondary | close |
| `0.70, 0.72, 0.78` | Text.Secondary | close |
| `0.78, 0.78, 0.85` | Text.Secondary | loose |
| `0.78, 0.80, 0.88` | Text.Primary | loose |
| `0.85, 0.87, 0.95` | Text.Primary | close |
| `0.92, 0.93, 0.96` | Text.Primary | close |

Eleven values for three text tiers. Nobody chose eleven; they accumulated,
because there was nowhere to read the right one from. That is the whole
argument for the token layer, stated in data.

These collapse to `Text.Primary` / `Text.Secondary` / `Text.Muted` with no
design decision required — the drift is not carrying meaning.

## 4. Genuinely one-off

The remainder are per-widget accents with no repeat and no category. They can
take the nearest token or stay literal; neither choice costs anything. Not
worth a decision.

---

## Order of work, when P3b runs

1. **§1 first** — five sites, meaning already correct, zero risk.
2. **§3 next** — mechanical, no decisions.
3. **§2 last** — needs the `Node.*` family defined first, and Light/Character
   need new hues, so it carries the only real design judgment here.

Do not do any of this before P3b rewrites these panels. Every file in §1 and §3
is one that pass substantially changes, and editing them twice is churn that
makes the rewrite's diff harder to read.

---

## Where the sweep stops, and why (2026-08-25)

The migration is finished in the sense that matters: every colour that is
*Hayba chrome* now comes from the style set. What remains is 34 literals that
were each looked at and deliberately left. Listing them is the point — an
undocumented remainder reads as "we ran out of steam", and the next person
sweeps the ones that must not be swept.

### Left because they are data, not chrome

All `handlers/` colours, and `Studio/HaybaStudioModel.cpp:23`. A handler's
`FLinearColor` is a material constant, a debug-draw colour, or a value parsed
out of JSON that came from the caller. The Studio one is the fallback for an
unparseable hex string the *user* typed. Tokenising any of these would change
what the tool does, not how it looks.

### Left because they belong to Unreal's visual language, not ours

`Studio/Graph/HaybaConstraintGraphNode.cpp` (5 node title colours) and
`HaybaConstraintGraphSchema.cpp` (4 pin colours).

These render inside `UEdGraph` — the same editor that draws Blueprints. A
Blueprint author reads pin colour as a *type*, and that reading is trained by
the engine, not by us: exec-white, object-blue, and so on. Our pins sit in
that same grammar. Pulling them onto the Hayba palette would make the
constraint graph the one graph in the editor where pin colour means something
different, which is a worse outcome than palette inconsistency.

This is the general rule the sweep discovered: **a token layer owns the
surfaces we draw, and stops at surfaces the host draws.**

### Left because they need a palette decision, not a sweep

`HaybaMCPSceneMapPanel.cpp:215-221` — seven semantic node colours (Foliage,
Building, Light, Trigger, Character, Blueprint, plus a neutral).

This is a real categorical ramp and it genuinely wants tokens. But it is a
*third* axis, distinct from both existing ones: `Cat.*` classifies what a tool
call was about, `Status.*` says how a thing turned out, and this classifies
what an actor IS in the world. Adding `Semantic.*` is a design addition, and
one palette addition is already awaiting sign-off (`Status.Warn` / `Info`).
Stacking a second unapproved axis would mean two visible changes landing
together with no one having agreed to either.

### Left because the alpha is load-bearing

`HaybaMCPSceneMapPanel.cpp:132` (alpha 0.9) and `HaybaMCPPlanPanel.cpp:166`
(alpha 0.85). Tokens carry no alpha, so these would become
`FLinearColor C = Colour(...); C.A = 0.9f;` — three lines to say what one line
says now, and the token would no longer be the whole answer at the call site.
Not worth it for two sites. If a third appears, add an alpha-aware accessor
rather than repeating the dance.

### The guard

`tools/style-token-check.mjs` catches the failure this layer actually has: a
token name that is typo'd compiles, links, runs, and renders **magenta** —
loud, but only to someone who opens that panel, on that tab, in that state. It
does not and should not flag remaining literals; the list above is why a blunt
"no literals anywhere" rule would be wrong.
