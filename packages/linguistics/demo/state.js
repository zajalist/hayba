/* State shape + persistence (multi-language).
   Backward-compatible with the existing 'hayba-ling-v3' key — same shape and
   the same set of keys, just lifted out of index.html. */

export const STATE_KEY = 'hayba-ling-v3';

export function defaultProsody() {
  return { stress: { kind: 'none' }, toneRules: [], sandhi: [], toneEnabled: false };
}

export function defaultState() {
  return {
    selected: new Set(['p','t','k','m','n','s','l','j','w','i','a','u']),
    active: 'm',
    heatmap: false,
    heatmapMode: 'npmi',
    langId: 'my-conlang',
    view: 'phonology',
    lexicon: [],
    rules: '',
    allophony: { rulesText: '' },
    applyAllophony: false,
    prosody: defaultProsody(),
    romRules: [],
    romTest: 'paʃa',
    inspectorPinned: true,
    grammar: { def: null, stem: '', rules: [], derivationRules: [] },
    typology: {},
    languages: {},
    wordlinks: [],
    nameGenScratch: null,
    ttsEnabled: true,
    phrasePack: null,
    suggestedLegality: [],
    userCustomizedLegality: {},
  };
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    // L29/L30 migration: userCustomizedLegality was originally a string[] of
    // "onset|coda" keys. The cell-click toggle now stores a Record keyed by
    // those strings with values 'legal'|'restricted'|'illegal'. Treat any
    // legacy array entries as 'legal' for back-compat.
    let userCustomizedLegality = j.userCustomizedLegality;
    if (Array.isArray(userCustomizedLegality)) {
      const migrated = {};
      for (const k of userCustomizedLegality) migrated[k] = 'legal';
      userCustomizedLegality = migrated;
    } else if (!userCustomizedLegality || typeof userCustomizedLegality !== 'object') {
      userCustomizedLegality = {};
    }
    return {
      ...j,
      selected: new Set(j.selected),
      userCustomizedLegality,
      suggestedLegality: j.suggestedLegality ?? [],
      lexicon: j.lexicon ?? [],
      romRules: j.romRules ?? [],
      rules: j.rules ?? '',
      allophony: j.allophony ?? { rulesText: '' },
      applyAllophony: j.applyAllophony ?? false,
      prosody: j.prosody ?? defaultProsody(),
      romTest: j.romTest ?? 'paʃa',
      inspectorPinned: j.inspectorPinned ?? true,
      grammar: j.grammar ?? { def: null, stem: '', rules: [] },
      typology: j.typology ?? {},
      languages: j.languages ?? {},
      wordlinks: j.wordlinks ?? [],
      nameGenScratch: j.nameGenScratch ?? null,
      ttsEnabled: j.ttsEnabled ?? true,
      phrasePack: j.phrasePack ?? null,
      derivationResults: null,
    };
  } catch {
    return null;
  }
}

export function saveState(state) {
  localStorage.setItem(STATE_KEY, JSON.stringify({
    ...state,
    selected: [...state.selected],
  }));
}

/** Capture the active language's facets so they can be restored on switch back. */
export function snapshotActiveLanguage(state) {
  state.languages[state.langId] = {
    selected: [...state.selected],
    lexicon: [...state.lexicon],
    rules: state.rules,
    allophony: state.allophony ?? { rulesText: '' },
    prosody: state.prosody ?? defaultProsody(),
    romRules: state.romRules,
    grammar: state.grammar,
    typology: { ...(state.typology ?? {}) },
  };
}

/** Load a language snapshot into the live editor slots. */
export function loadLanguageSnapshot(state, langId) {
  const snap = state.languages[langId];
  if (snap) {
    state.selected = new Set(snap.selected);
    state.lexicon = snap.lexicon;
    state.rules = snap.rules;
    state.allophony = snap.allophony ?? { rulesText: '' };
    state.prosody = snap.prosody ?? defaultProsody();
    state.romRules = snap.romRules;
    state.grammar = snap.grammar ?? { def: null, stem: '', rules: [], derivationRules: [] };
    if (!state.grammar.derivationRules) state.grammar.derivationRules = [];
    state.typology = snap.typology ?? {};
  } else {
    state.lexicon = [];
    state.rules = '';
    state.allophony = { rulesText: '' };
    state.prosody = defaultProsody();
    state.romRules = [];
    state.grammar = { def: null, stem: '', rules: [], derivationRules: [] };
    state.typology = {};
  }
  state.langId = langId;
}
