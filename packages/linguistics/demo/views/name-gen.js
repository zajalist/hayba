/* Name Generator view.
   - Roll button generates 20 phonotactic candidates; clicking a result saves
     to lexicon under a prompted concept.
   - Honours state.nameGenScratch (one-shot onset/coda override from the
     phonotactic legality heatmap, cleared after the next roll). */

import { escapeHtml, $ } from '../components/utils.js';

let _wired = false;

export function init(ctx) {
  if (_wired) return;
  _wired = true;
  const {
    state, saveState, deps, render, ENGINE,
  } = ctx;
  const {
    PULMONIC_CONSONANTS, NON_PULMONIC_CONSONANTS, CARDINAL_VOWELS,
    generatePhonotacticName, romanize,
  } = ENGINE;

  $('ng-roll').addEventListener('click', () => {
    const sel = [...state.selected];
    const cs = new Set([...PULMONIC_CONSONANTS, ...NON_PULMONIC_CONSONANTS].map(c => c.ipa));
    const vs = new Set(CARDINAL_VOWELS.map(v => v.ipa));
    const consonants = sel.filter(x => cs.has(x));
    const vowels = sel.filter(x => vs.has(x));
    if (consonants.length === 0 || vowels.length === 0) {
      alert('add at least one consonant and one vowel to the inventory.');
      return;
    }
    const baseSeed = BigInt($('ng-seed').value || 42);
    const cat = $('ng-cat').value;
    const tpl = $('ng-tpl').value;
    const syl = Number($('ng-syl').value || 2);
    const phono = deps.buildPhonologyJson();
    const nasals = [...PULMONIC_CONSONANTS]
      .filter(c => c.manner === 'nasal' && state.selected.has(c.ipa))
      .map(c => c.ipa);
    const scratch = state.nameGenScratch;
    const onsetPool = scratch ? [scratch.onset] : consonants;
    const codaPool = scratch && scratch.coda ? [scratch.coda] : consonants;
    const grid = $('ng-results');
    grid.innerHTML = '';
    for (let i = 0; i < 20; i++) {
      try {
        const name = generatePhonotacticName({
          phonology: phono,
          phonotactics: { phonologyId: phono.languageId, vowels, syllable: { templates: [tpl] } },
          profile: { syllableTemplate: tpl, vowels, onsetPool, codaPool, nasalPool: nasals.length ? nasals : undefined },
          syllableCount: syl, seed: baseSeed,
          category: cat, instance: `${i}`,
        });
        const map = { languageId: state.langId, rules: state.romRules };
        const rom = state.romRules.length ? romanize(name, map) : '';
        const div = document.createElement('div');
        div.style.cssText = 'background:var(--bg-panel); border:1px solid var(--border-soft); padding:6px 8px; border-radius:2px; cursor:pointer';
        div.innerHTML = `<span class="accent">${escapeHtml(name)}</span>${rom ? ` <span style="color:var(--text-muted)">· ${escapeHtml(rom)}</span>` : ''}`;
        div.addEventListener('click', () => {
          const concept = prompt(`save "${name}" under which concept?`);
          if (!concept) return;
          const idx = state.lexicon.findIndex(e => e.concept === concept);
          const entry = { concept, lemma: name, ipa: name, register: 'neutral' };
          if (idx >= 0) state.lexicon[idx] = entry; else state.lexicon.push(entry);
          saveState(state);
          render(['lexicon', 'rules']);
        });
        grid.appendChild(div);
      } catch {}
    }
    if (scratch) {
      state.nameGenScratch = null;
      saveState(state);
      renderScratchHint(state);
    }
  });
}

export function renderScratchHint(state) {
  const el = $('ng-scratch-hint');
  if (!el) return;
  const s = state.nameGenScratch;
  if (!s) { el.style.display = 'none'; el.textContent = ''; return; }
  const codaStr = s.coda ? ` + /${s.coda}/` : '';
  el.textContent = `seeded from heatmap: /${s.onset}/${codaStr}`;
  el.style.display = '';
}

export function render(state /*, deps */) {
  renderScratchHint(state);
}
