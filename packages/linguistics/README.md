# @hayba/linguistics

Linguistics engine for Hayba: phonology, phonotactics, lexicon, morphology,
sound changes, translation, and friends.

## PHOIBLE full corpus (opt-in)

The bundled `INVENTORIES` export is a hand-curated 20-language subset of
PHOIBLE 2.0 — enough to drive the L1 co-occurrence demo without shipping the
full ~12MB corpus inside the npm tree.

To use the full PHOIBLE corpus, download `phoible.csv` from
<https://github.com/phoible/dev/blob/master/data/phoible.csv> and run:

```bash
npm run import:phoible --workspace @hayba/linguistics -- /path/to/phoible.csv
```

This writes `src/data/inventories.phoible.json` (gitignored). At runtime,
`loadPhoibleCorpus()` will pick up that file automatically and fall back to
the bundled subset when absent.

PHOIBLE is licensed CC-BY-SA 4.0 — builds that redistribute the full corpus
must preserve attribution to the PHOIBLE 2.0 project
(Moran & McCloy, eds., 2019, <https://phoible.org>).
