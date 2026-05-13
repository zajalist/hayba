# StyleSheet `extras` glossary

The `extras` field on `StyleSheet` is an open `FeatureBundle` (`Record<string, string | string[]>`) for culture-specific concepts that don't fit the typed `core` fields. Every key used by a seed StyleGuide must appear here.

Promote a key to `StyleSheet.core` (a real typed field) once it generalizes across cultures.

## Keys in use

| Key | Cultures using it | Type | Notes |
|---|---|---|---|
| `bayWindows` | industrial-revolution-english | string | Frequency tag, e.g. `"common"`. |
| `chimneyStacks` | industrial-revolution-english | string | Height tag, e.g. `"tall"`. |
| `colorPalette` | tang-chinese | string[] | Named pigments. |
| `cornice` | industrial-revolution-english | string | Material tag, e.g. `"stone"`. |
| `defensiveWalls` | medieval-european-carolingian | string | Material tag. |
| `dougong` | tang-chinese | string | Bracket-set complexity tag (`present` / `elaborate`). |
| `eaves` | tang-chinese-9c | string | Overhang depth tag. |
| `engawa` | edo-japanese | string | Verandah strip, `"present"` if part of vernacular. |
| `kawara` | edo-japanese-late | string | Clay tile roof tag. |
| `multiBuilding` | hausa-classical | string | `"true"` marks compound-typology archetypes; A3 may treat as cluster. |
| `niches` | andean-inca | string | Wall-niche shape tag (`trapezoidal`). |
| `pinnacles` | hausa-classical | string | Roof-edge ornament (azara pinnacles). |
| `roofPitch` | medieval-european-carolingian | string | Steepness tag. |
| `shoji` | edo-japanese-early | string | Paper-screen partition prevalence. |
| `stainedGlass` | medieval-european-gothic | string | Frequency tag. |
| `tokonoma` | edo-japanese-early | string | Decorative alcove prevalence. |
| `tracery` | medieval-european-gothic | string | Window-stonework style tag. |
| `tubali` | hausa-classical | string | Molded mud cones, characteristic of Hausa Zaure. |
| `vaulting` | medieval-european-romanesque | string | Roof-vault style. |
| `verticalEmphasis` | medieval-european-gothic | string | Massing tag. |
| `wallStyle` | andean | string | Polygonal-fitted vs. coursed-adobe. |
| `windowSize` | medieval-european-romanesque | string | Relative size tag. |

## Promotion candidates

Keys appearing in 3+ cultures should be considered for promotion to `core`:

- `wallStyle` (currently 2 cultures) — could become `core.wallStyle: 'fitted-polygonal' | 'coursed' | 'tubali' | ...` once a third culture lands.
- `roofPitch` — overlaps semantically with `roofType`; consider folding into roof-type tags rather than promoting.

## Authoring rules

1. New extras keys MUST be added to this table in the same commit as the StyleGuide JSON that introduces them.
2. Don't reuse a key for a different concept across cultures. If two cultures need different `tracery` semantics, namespace: `tracery.medieval-european`.
3. Prefer `string` over `string[]` unless the field is genuinely a set (e.g., `colorPalette`).
