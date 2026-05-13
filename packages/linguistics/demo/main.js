import {
  PULMONIC_CONSONANTS, NON_PULMONIC_CONSONANTS, CARDINAL_VOWELS,
  buildCoOccurrenceModel, INVENTORIES, audioUrlFor,
  consonantToPhonemeFeatures, vowelToPhonemeFeatures,
  parseRules, stringifyRule, evolveLexicon, generatePhonotacticName, deriveSeed,
  clusterLegality,
  defaultRomanization, romanize,
  translate, renderRomanized,
  buildParadigm, findRuleConflicts, PRESET_PARADIGMS,
  addAxis, removeAxis, addAxisValue, removeAxisValue,
  createLoanwordAdapter,
  computeLexiconStatistics,
  InMemoryWordlinks, autoCognatesFromDiachrony,
  buildFamilyTree,
  TYPOLOGY_FEATURES, TYPOLOGY_PRESETS, profileSummary,
} from '../dist/index.js';
import {
  defaultState, loadState as _loadState, saveState as _saveState,
  snapshotActiveLanguage as _snapshotActiveLanguage,
  loadLanguageSnapshot as _loadLanguageSnapshot,
} from './state.js';
import { escapeHtml } from './components/utils.js';
import { attachPopover, closeActivePopover } from './components/popover.js';
import * as NameGenView from './views/name-gen.js';

/* state - load/save/snapshot helpers live in ./state.js */
const state = _loadState() ?? defaultState();
function saveState() { _saveState(state); }
function snapshotActiveLanguage() { _snapshotActiveLanguage(state); }
function loadLanguageSnapshot(langId) { _loadLanguageSnapshot(state, langId); }

const model = buildCoOccurrenceModel();

/* ─────────────────────  navigation  ───────────────────── */
document.querySelectorAll('nav button[data-view]').forEach(b => {
  b.addEventListener('click', () => {
    state.view = b.dataset.view; saveState(); renderNav();
  });
});
function renderNav() {
  document.querySelectorAll('nav button[data-view]').forEach(b => {
    b.classList.toggle('active', b.dataset.view === state.view);
  });
  document.querySelectorAll('.view').forEach(v => {
    v.classList.toggle('active', v.id === `view-${state.view}`);
  });
}

/* ─────────────────────  IPA chart  ───────────────────── */
const PLACE_ORDER = [
  'bilabial','labiodental','linguolabial','dental','alveolar','postalveolar',
  'retroflex','alveolo-palatal','palatal','velar','uvular','pharyngeal','epiglottal','glottal',
  'labial-velar','labial-palatal',
];
const MANNER_ORDER = [
  'nasal','plosive','sibilant-fricative','fricative','lateral-fricative',
  'approximant','lateral-approximant','tap','lateral-tap','trill','affricate',
  'click','implosive','ejective',
];
const HEIGHT_ORDER   = ['close','near-close','close-mid','mid','open-mid','near-open','open'];
const BACKNESS_ORDER = ['front','central','back'];

function makeCell(ipa) {
  const d = document.createElement('div');
  d.className = 'cell'; d.dataset.ipa = ipa;
  d.innerHTML = `${ipa}<span class="p"></span>`;
  d.addEventListener('click', () => inspect(ipa));
  d.addEventListener('dblclick', () => toggleInventory(ipa));
  d.title = `Click to inspect · double-click to add/remove`;
  return d;
}

// Place groupings (Labial / Coronal / Dorsal / Laryngeal) — matches IPA conventions
// for visual separation between major articulation zones.
const PLACE_GROUP = {
  bilabial: 'labial', labiodental: 'labial', linguolabial: 'labial',
  dental: 'coronal', alveolar: 'coronal', postalveolar: 'coronal',
  retroflex: 'coronal', 'alveolo-palatal': 'coronal',
  palatal: 'dorsal', velar: 'dorsal', uvular: 'dorsal',
  pharyngeal: 'laryngeal', epiglottal: 'laryngeal', glottal: 'laryngeal',
  'labial-velar': 'co-articulated', 'labial-palatal': 'co-articulated',
};
const GROUP_COLOR = {
  labial: 'rgba(106,159,220,0.10)',
  coronal: 'rgba(126,196,142,0.10)',
  dorsal: 'rgba(232,165,96,0.10)',
  laryngeal: 'rgba(198,133,192,0.10)',
  'co-articulated': 'rgba(255,255,255,0.06)',
};

/** Standard IPA chart cell: voiceless left, voiced right, share one td. */
function buildConsonantGrid(targetId, items) {
  const presentPlaces = new Set(items.map(i => i.place));
  const presentManners = new Set(items.map(i => i.manner));
  const cols = PLACE_ORDER.filter(p => presentPlaces.has(p));
  const rows = MANNER_ORDER.filter(m => presentManners.has(m));

  const tbl = document.createElement('table'); tbl.className = 'ipa-table';

  // Group super-row (labial / coronal / dorsal / laryngeal banner)
  const groupRow = tbl.insertRow();
  groupRow.className = 'group-row';
  const cornerGroup = document.createElement('th');
  cornerGroup.className = 'row'; cornerGroup.textContent = '';
  groupRow.appendChild(cornerGroup);
  let i = 0;
  while (i < cols.length) {
    const g = PLACE_GROUP[cols[i]] ?? '';
    let span = 1;
    while (i + span < cols.length && PLACE_GROUP[cols[i + span]] === g) span++;
    const th = document.createElement('th');
    th.colSpan = span;
    th.className = 'group-header';
    th.textContent = g;
    th.style.background = GROUP_COLOR[g] ?? '';
    groupRow.appendChild(th);
    i += span;
  }

  // Column header row
  const thead = tbl.insertRow();
  const cornerHead = document.createElement('th');
  cornerHead.className = 'row corner';
  cornerHead.innerHTML = `<span style="color:var(--text-muted); font-size:9px;">manner ↓ / place →</span>`;
  thead.appendChild(cornerHead);
  for (const c of cols) {
    const th = document.createElement('th');
    th.textContent = c.replace(/-/g, '-​');
    th.dataset.place = c;
    thead.appendChild(th);
  }

  // Body rows
  for (const r of rows) {
    const tr = tbl.insertRow();
    tr.dataset.manner = r;
    const lab = document.createElement('th'); lab.className = 'row';
    lab.textContent = r.replace(/-/g, '-​'); tr.appendChild(lab);
    for (const c of cols) {
      const td = document.createElement('td');
      td.dataset.place = c;
      const grp = PLACE_GROUP[c]; if (grp) td.dataset.group = grp;
      const voiceless = items.find(i => i.manner === r && i.place === c && i.voicing === 'voiceless');
      const voiced    = items.find(i => i.manner === r && i.place === c && i.voicing === 'voiced');
      if (voiceless || voiced) {
        const wrap = document.createElement('div'); wrap.className = 'cell-pair';
        if (voiceless) wrap.appendChild(makeCell(voiceless.ipa)); else wrap.appendChild(document.createElement('div'));
        if (voiced)    wrap.appendChild(makeCell(voiced.ipa));    else wrap.appendChild(document.createElement('div'));
        td.appendChild(wrap);
      }
      tr.appendChild(td);
    }
  }
  document.getElementById(targetId).appendChild(tbl);
}

/** Vowel grid: unrounded | rounded per (height, backness). */
function buildVowelGrid(targetId, items) {
  const tbl = document.createElement('table'); tbl.className = 'ipa-table';
  const thead = tbl.insertRow(); thead.insertCell();
  for (const c of BACKNESS_ORDER) { const th = document.createElement('th'); th.textContent = c; thead.appendChild(th); }
  for (const r of HEIGHT_ORDER) {
    if (!items.some(i => i.height === r)) continue;
    const tr = tbl.insertRow();
    const lab = document.createElement('th'); lab.className = 'row'; lab.textContent = r; tr.appendChild(lab);
    for (const c of BACKNESS_ORDER) {
      const td = document.createElement('td');
      const unr = items.find(i => i.height === r && i.backness === c && i.roundness === 'unrounded');
      const rnd = items.find(i => i.height === r && i.backness === c && i.roundness === 'rounded');
      if (unr || rnd) {
        const wrap = document.createElement('div'); wrap.className = 'cell-pair';
        if (unr) wrap.appendChild(makeCell(unr.ipa)); else wrap.appendChild(document.createElement('div'));
        if (rnd) wrap.appendChild(makeCell(rnd.ipa)); else wrap.appendChild(document.createElement('div'));
        td.appendChild(wrap);
      }
      tr.appendChild(td);
    }
  }
  document.getElementById(targetId).appendChild(tbl);
}

buildConsonantGrid('grid-pulmonic',    PULMONIC_CONSONANTS);
buildConsonantGrid('grid-nonpulmonic', NON_PULMONIC_CONSONANTS);
buildVowelGrid    ('grid-vowels',      CARDINAL_VOWELS);

function inspect(ipa) {
  state.active = ipa; saveState(); renderPhonology();
}
function toggleInventory(ipa) {
  if (state.selected.has(ipa)) state.selected.delete(ipa); else state.selected.add(ipa);
  state.active = ipa; saveState(); renderPhonology(); renderTopbar(); renderRomanization();
}

document.getElementById('inspector-toggle').addEventListener('click', () => {
  if (state.active) toggleInventory(state.active);
});

/* —— Presets —— */
const PRESETS = [
  { name: 'Minimal (Pirahã-like)', phonemes: ['p','t','k','ʔ','h','b','i','o','a'] },
  { name: 'Polynesian (Hawaiian)', phonemes: ['p','k','ʔ','m','n','h','l','w','i','e','a','o','u'] },
  { name: 'Romance (Spanish core)', phonemes: ['p','t','k','b','d','ɡ','m','n','ɲ','f','s','x','l','ʎ','r','j','w','i','e','a','o','u'] },
  { name: 'Germanic (English core)', phonemes: ['p','t','k','b','d','ɡ','m','n','ŋ','f','v','θ','ð','s','z','ʃ','ʒ','h','l','j','w','ɹ','i','ɪ','e','ɛ','æ','ə','a','ɑ','ɔ','o','ʊ','u'] },
  { name: 'Slavic (Russian-ish)', phonemes: ['p','t','k','b','d','ɡ','m','n','f','v','s','z','ʃ','ʒ','x','l','j','r','t͡s','t͡ʃ','i','e','a','o','u'] },
  { name: 'Sino-Tibetan (Mandarin-ish)', phonemes: ['p','t','k','m','n','ŋ','f','s','ʃ','x','l','j','w','t͡s','t͡ʃ','t͡ɕ','ɕ','i','y','u','e','o','a','ə'] },
  { name: 'Click-rich (Xhosa-ish flavour)', phonemes: ['p','t','k','b','d','ɡ','m','n','ŋ','f','s','ʃ','h','l','j','w','ǀ','ǃ','ǂ','ɡǀ','ɡǃ','i','e','a','o','u'] },
  { name: 'Tonal Mainland SEA (Thai-ish)', phonemes: ['p','t','k','b','d','m','n','ŋ','f','s','h','l','j','w','r','i','e','ɛ','a','u','o','ɔ','ə','pʼ','tʼ','kʼ'] },
];
const presetList = document.getElementById('preset-list');
for (const p of PRESETS) {
  const b = document.createElement('button');
  b.innerHTML = `<div>${p.name}</div><div class="ph">${p.phonemes.join('  ')}</div>`;
  b.addEventListener('click', () => {
    state.selected = new Set(p.phonemes);
    state.active = p.phonemes[0]; saveState();
    document.getElementById('preset-dlg').classList.remove('open');
    renderAll();
  });
  presetList.appendChild(b);
}
document.getElementById('inv-presets').addEventListener('click', () =>
  document.getElementById('preset-dlg').classList.add('open'));
document.getElementById('preset-cancel').addEventListener('click', () =>
  document.getElementById('preset-dlg').classList.remove('open'));
document.getElementById('preset-dlg').addEventListener('click', e => {
  if (e.target.id === 'preset-dlg') e.target.classList.remove('open');
});
document.getElementById('inv-clear').addEventListener('click', () => {
  if (!confirm('Remove all phonemes from the inventory?')) return;
  state.selected = new Set(); saveState(); renderAll();
});

function lerpColor(w) {
  const stops = [[0,[13,41,66]],[0.4,[26,106,166]],[0.7,[224,138,58]],[1,[208,69,69]]];
  for (let i=0;i<stops.length-1;i++){ const [w0,c0]=stops[i],[w1,c1]=stops[i+1];
    if (w<=w1){ const t=(w-w0)/(w1-w0); const c=c0.map((v,j)=>Math.round(v+(c1[j]-v)*t));
      return `rgb(${c[0]},${c[1]},${c[2]})`; }
  } return 'rgb(208,69,69)';
}

function inventoryFit() {
  const sel = [...state.selected]; if (sel.length < 2) return null;
  let sum=0,n=0;
  for (const a of sel) for (const b of sel) if (a !== b) { sum += model.pGivenPresent(b, a); n++; }
  return sum / n;
}

function buildPhonologyJson() {
  const phonemes = [];
  for (const c of [...PULMONIC_CONSONANTS, ...NON_PULMONIC_CONSONANTS])
    if (state.selected.has(c.ipa)) phonemes.push({ id: c.ipa, ipa: c.ipa, features: consonantToPhonemeFeatures(c) });
  for (const v of CARDINAL_VOWELS)
    if (state.selected.has(v.ipa)) phonemes.push({ id: v.ipa, ipa: v.ipa, features: vowelToPhonemeFeatures(v) });
  return { languageId: state.langId || 'my-conlang', phonemes };
}

function describePhoneme(meta) {
  if (!meta) return '';
  if ('manner' in meta) {
    const v = meta.voicing === 'voiced' ? 'Voiced' : 'Voiceless';
    return `${v} ${meta.place} ${meta.manner.replace(/-/g, ' ')}`;
  }
  return `${meta.height} ${meta.backness} ${meta.roundness} vowel`;
}

function renderPhonology() {
  let weights = null;
  if (state.heatmap && state.active) {
    const cs = [...document.querySelectorAll('.cell')].map(d => d.dataset.ipa);
    weights = model.heatmapWeights(state.active, cs, state.heatmapMode);
  }
  for (const d of document.querySelectorAll('.cell')) {
    const ipa = d.dataset.ipa;
    if (weights) {
      const w = weights.get(ipa) ?? 0;
      d.style.background = lerpColor(w);
    } else {
      d.style.background = '';
    }
    d.classList.toggle('selected', state.selected.has(ipa));
    d.classList.toggle('active', ipa === state.active);
  }

  // Inspector
  document.getElementById('active-ipa').textContent = state.active ?? '—';
  const meta = state.active
    ? [...PULMONIC_CONSONANTS, ...NON_PULMONIC_CONSONANTS, ...CARDINAL_VOWELS].find(p => p.ipa === state.active)
    : null;
  const nameEl = document.getElementById('active-name');
  const featEl = document.getElementById('active-features');
  const statsEl = document.getElementById('active-stats');
  const rarityEl = document.getElementById('active-rarity');
  const companionsEl = document.getElementById('active-companions');
  const langsEl = document.getElementById('active-langs');
  if (meta) {
    nameEl.textContent = describePhoneme(meta);
    featEl.innerHTML = Object.entries(meta)
      .filter(([k]) => k !== 'symbol' && k !== 'ipa')
      .map(([k,v]) => `<span style="color:var(--text-muted)">${k}:</span> ${v}`).join(' · ');
    const marg = model.marginal(state.active);
    const rarityLabel =
      marg > 0.85 ? 'near-universal' :
      marg > 0.55 ? 'common' :
      marg > 0.25 ? 'attested' :
      marg > 0.10 ? 'rare' : 'very rare';
    rarityEl.innerHTML = `
      <b style="color:var(--text-primary)">Frequency</b> · ${(marg*100).toFixed(0)}% of world languages
      <span class="tag" style="margin-left:6px">${rarityLabel}</span>`;
    const companions = model.topCoOccurring(state.active, 5);
    companionsEl.innerHTML = `<div class="hint" style="margin-bottom:4px"><b style="color:var(--text-primary)">Often co-occurs with</b></div>`
      + companions.map(c => `
        <div class="companion" data-jump="${c.ipa}">
          <span class="ipa">/${c.ipa}/</span>
          <span class="name">${escapeHtml(describePhoneme([...PULMONIC_CONSONANTS, ...NON_PULMONIC_CONSONANTS, ...CARDINAL_VOWELS].find(p => p.ipa === c.ipa)))}</span>
          <span class="pct">${(c.p*100).toFixed(0)}%</span>
        </div>`).join('');
    companionsEl.querySelectorAll('[data-jump]').forEach(el =>
      el.addEventListener('click', () => inspect(el.dataset.jump)));
    const langs = model.languagesWith(state.active);
    langsEl.innerHTML = langs.length
      ? `<b style="color:var(--text-primary)">Sample languages</b><br>${escapeHtml(langs.slice(0, 8).join(', '))}${langs.length>8?'…':''}`
      : `<b style="color:var(--text-primary)">Sample languages</b><br>Not in the bundled corpus — heatmap falls back to universal prior.`;
  } else {
    nameEl.textContent = 'Click any phoneme';
    featEl.textContent = 'Single click = inspect. Double-click a cell, or use the button below, to add/remove from your inventory.';
    rarityEl.innerHTML = '';
    companionsEl.innerHTML = '';
    langsEl.innerHTML = '';
  }
  // Inspector toggle button reflects current state
  const btn = document.getElementById('inspector-toggle');
  if (!state.active) {
    btn.textContent = 'Select a phoneme'; btn.disabled = true;
    btn.classList.remove('danger');
  } else if (state.selected.has(state.active)) {
    btn.textContent = `− Remove /${state.active}/ from inventory`;
    btn.disabled = false; btn.classList.remove('primary'); btn.classList.add('danger');
  } else {
    btn.textContent = `+ Add /${state.active}/ to inventory`;
    btn.disabled = false; btn.classList.add('primary'); btn.classList.remove('danger');
  }
  // Audio
  const url = state.active ? audioUrlFor(state.active) : null;
  const audio = document.getElementById('audio'); const link = document.getElementById('audio-link');
  if (url) { audio.src = url; audio.style.display=''; link.href=url; link.textContent='Listen on Wikimedia Commons →'; }
  else { audio.removeAttribute('src'); audio.style.display='none'; link.textContent=''; }

  // Inventory chips
  const chipStrip = document.getElementById('inv-chips');
  const sel = [...state.selected];
  const cs = new Set([...PULMONIC_CONSONANTS, ...NON_PULMONIC_CONSONANTS].map(c => c.ipa));
  const vs = new Set(CARDINAL_VOWELS.map(v => v.ipa));
  const cCount = sel.filter(x => cs.has(x)).length;
  const vCount = sel.filter(x => vs.has(x)).length;
  if (sel.length === 0) {
    chipStrip.innerHTML = `<span class="hint" id="inv-empty-hint">Click any phoneme in the chart below, then press <b>+ Add to inventory</b>. Or just double-click a cell. Chips you add appear here — click × to remove.</span>`;
  } else {
    chipStrip.innerHTML = '';
    for (const ipa of sel) {
      const chip = document.createElement('span');
      chip.className = 'chip' + (ipa === state.active ? ' active' : '');
      chip.innerHTML = `<span class="mono">${escapeHtml(ipa)}</span><button class="x" title="remove">×</button>`;
      chip.addEventListener('click', e => {
        if (e.target.classList.contains('x')) { toggleInventory(ipa); }
        else { inspect(ipa); }
      });
      chipStrip.appendChild(chip);
    }
  }

  // Stats
  document.getElementById('s-count').textContent = sel.length;
  document.getElementById('s-c').textContent = cCount;
  document.getElementById('s-v').textContent = vCount;
  const fit = inventoryFit();
  document.getElementById('s-fit').textContent = fit == null ? '—' : fit.toFixed(3);
  document.getElementById('stats-fit').textContent = fit == null ? '—' : `fit ${fit.toFixed(3)}`;
  document.getElementById('fit-meta-top').textContent = fit == null ? 'cross-linguistic fit —' : `cross-linguistic fit ${fit.toFixed(3)}`;
  document.getElementById('inv-summary').textContent = sel.length === 0
    ? 'empty'
    : `${sel.length} phonemes · ${cCount} consonant${cCount===1?'':'s'} · ${vCount} vowel${vCount===1?'':'s'}`;

  // Rich inventory diagnostics
  const ratio = vCount === 0 ? '—' : (cCount / vCount).toFixed(2);
  document.getElementById('s-ratio').textContent = ratio;
  const allCons = [...PULMONIC_CONSONANTS, ...NON_PULMONIC_CONSONANTS];
  const selectedConsRecords = allCons.filter(c => state.selected.has(c.ipa));
  const placesUsed = new Set(selectedConsRecords.map(c => c.place)).size;
  const mannersUsed = new Set(selectedConsRecords.map(c => c.manner)).size;
  // Voicing pairs: count (manner, place) buckets where both voiceless and voiced are selected
  const placeMannerByVoicing = new Map();
  for (const c of selectedConsRecords) {
    const k = `${c.manner}|${c.place}`;
    if (!placeMannerByVoicing.has(k)) placeMannerByVoicing.set(k, new Set());
    placeMannerByVoicing.get(k).add(c.voicing);
  }
  const pairs = [...placeMannerByVoicing.values()].filter(s => s.has('voiceless') && s.has('voiced')).length;
  document.getElementById('s-pairs').textContent = pairs;
  document.getElementById('s-places').textContent = placesUsed;
  document.getElementById('s-manners').textContent = mannersUsed;
  document.getElementById('s-syl').textContent = (cCount * vCount).toLocaleString();

  // Typology tags
  const tagsEl = document.getElementById('s-tags');
  tagsEl.innerHTML = '';
  const tags = [];
  if (sel.length === 0) tags.push({ label: 'empty', muted: true });
  else {
    if (sel.length < 14) tags.push({ label: 'small inventory' });
    else if (sel.length > 40) tags.push({ label: 'large inventory' });
    else tags.push({ label: 'medium inventory', muted: true });
    const sizeRatio = vCount > 0 ? cCount / vCount : Infinity;
    if (sizeRatio > 4) tags.push({ label: 'consonant-heavy' });
    if (sizeRatio < 1.2 && vCount > 0) tags.push({ label: 'vowel-heavy' });
    if (selectedConsRecords.some(c => c.manner === 'click')) tags.push({ label: 'click-using' });
    if (selectedConsRecords.some(c => c.manner === 'ejective')) tags.push({ label: 'ejective' });
    if (selectedConsRecords.some(c => c.manner === 'implosive')) tags.push({ label: 'implosive' });
    if (selectedConsRecords.some(c => c.place === 'retroflex')) tags.push({ label: 'retroflex' });
    if (selectedConsRecords.some(c => c.place === 'uvular' || c.place === 'pharyngeal' || c.place === 'epiglottal')) tags.push({ label: 'back-articulated' });
    if (vCount >= 12) tags.push({ label: 'rich vowel system' });
    if (vCount > 0 && vCount <= 3) tags.push({ label: 'minimal vowels' });
    // L15 — surface typology highlights as tags
    const typ = state.typology ?? {};
    if (typ.word_order && typ.word_order !== 'free') tags.push({ label: typ.word_order });
    if (typ.word_order === 'free') tags.push({ label: 'free word order' });
    if (typ.tone && typ.tone !== 'none') tags.push({ label: 'tonal' });
    if (typ.vowel_harmony && typ.vowel_harmony !== 'none') tags.push({ label: 'vowel harmony' });
    if (typ.polysynthesis === 'yes') tags.push({ label: 'polysynthetic' });
  }
  for (const t of tags) {
    const el = document.createElement('span');
    el.className = 'tag' + (t.muted ? ' muted' : '');
    el.textContent = t.label;
    tagsEl.appendChild(el);
  }

  // Closest natural language
  const closestEl = document.getElementById('s-closest');
  if (sel.length === 0) {
    closestEl.textContent = '';
  } else {
    const close = model.closestLanguage(sel);
    if (close) {
      closestEl.innerHTML = `<b style="color:var(--text-primary)">Closest natural language</b><br>
        ${escapeHtml(close.language)} <span style="color:var(--text-muted)">(${escapeHtml(close.family)})</span> · Jaccard <span class="mono accent">${close.jaccard.toFixed(2)}</span>`;
    }
  }

  // Suggested additions
  const suggEl = document.getElementById('s-suggestions');
  if (sel.length === 0) {
    suggEl.innerHTML = `<div class="hint">Add some phonemes to see what cross-linguistically typical companions you might be missing.</div>`;
  } else {
    const suggestions = model.suggestedAdditions(sel, 5);
    suggEl.innerHTML = suggestions.map(s => {
      const meta = [...allCons, ...CARDINAL_VOWELS].find(p => p.ipa === s.ipa);
      const name = meta ? describePhoneme(meta) : '';
      return `<div class="companion" data-add="${escapeHtml(s.ipa)}">
        <span class="ipa">/${escapeHtml(s.ipa)}/</span>
        <span class="name">${escapeHtml(name)}</span>
        <span class="pct">${(s.marginal*100).toFixed(0)}%</span>
      </div>`;
    }).join('');
    suggEl.querySelectorAll('[data-add]').forEach(el =>
      el.addEventListener('click', () => toggleInventory(el.dataset.add)));
  }

  // Export JSON
  document.getElementById('export-out').value = JSON.stringify(buildPhonologyJson(), null, 2);
}

document.getElementById('heatmap-toggle').addEventListener('change', e => {
  state.heatmap = e.target.checked; saveState(); renderPhonology();
});
document.getElementById('heatmap-mode').addEventListener('change', e => {
  state.heatmapMode = e.target.value; saveState(); renderPhonology();
});
/* Multi-language switching (L13) - implementations live in ./state.js. */

document.getElementById('lang-id').addEventListener('change', e => {
  if (e.target.value === state.langId) return;
  snapshotActiveLanguage();
  loadLanguageSnapshot(e.target.value);
  saveState(); renderAll();
});

document.getElementById('lang-new').addEventListener('click', () => {
  const name = prompt('New language ID:', `language-${Object.keys(state.languages).length + 2}`);
  if (!name || !name.trim()) return;
  const id = name.trim();
  if (id === state.langId || state.languages[id]) {
    alert('That language ID is already in use.');
    return;
  }
  snapshotActiveLanguage();
  loadLanguageSnapshot(id);
  saveState(); renderAll();
});

document.getElementById('lang-rename').addEventListener('click', () => {
  const newName = prompt('Rename language:', state.langId);
  if (!newName || !newName.trim() || newName.trim() === state.langId) return;
  const oldId = state.langId;
  const newId = newName.trim();
  if (state.languages[newId]) { alert('A language with that ID already exists.'); return; }
  // Migrate wordlinks that referenced the old id.
  state.wordlinks = state.wordlinks.map(l => ({
    ...l,
    langA: l.langA === oldId ? newId : l.langA,
    langB: l.langB === oldId ? newId : l.langB,
  }));
  state.langId = newId;
  saveState(); renderAll();
});
/* —— Kebab menu —— */
const kebab = document.getElementById('kebab-btn');
const kebabMenu = document.getElementById('kebab-menu');
kebab.addEventListener('click', e => {
  e.stopPropagation();
  kebabMenu.classList.toggle('open');
});
document.addEventListener('click', () => kebabMenu.classList.remove('open'));
kebabMenu.addEventListener('click', e => e.stopPropagation());

document.getElementById('action-reset').addEventListener('click', () => {
  kebabMenu.classList.remove('open');
  if (!confirm('Reset all linguistics state? This clears inventory, lexicon, rules, and romanization.')) return;
  state.selected = new Set(); state.active = null;
  state.lexicon = []; state.rules = ''; state.romRules = [];
  saveState(); renderAll();
});

document.getElementById('action-copy-json').addEventListener('click', async () => {
  kebabMenu.classList.remove('open');
  await navigator.clipboard.writeText(JSON.stringify(buildPhonologyJson(), null, 2));
  const note = document.getElementById('copy-hint');
  if (note) { note.textContent = 'Phonology JSON copied to clipboard'; setTimeout(() => note.textContent = '', 2000); }
});

document.getElementById('action-import').addEventListener('click', () => {
  kebabMenu.classList.remove('open');
  document.getElementById('import-file').click();
});
document.getElementById('import-file').addEventListener('change', async e => {
  const file = e.target.files?.[0]; if (!file) return;
  try {
    const text = await file.text();
    const j = JSON.parse(text);
    if (j.phonology) {
      state.langId = j.phonology.languageId || state.langId;
      state.selected = new Set((j.phonology.phonemes || []).map(p => p.ipa));
    }
    if (j.lexicon) state.lexicon = j.lexicon;
    if (j.soundChangesText) state.rules = j.soundChangesText;
    if (j.romanization?.rules) state.romRules = j.romanization.rules;
    saveState(); renderAll();
  } catch (err) {
    alert('Could not import: ' + (err.message ?? err));
  }
  e.target.value = '';
});
document.getElementById('export-btn').addEventListener('click', () => {
  const payload = {
    phonology: buildPhonologyJson(),
    lexicon: state.lexicon,
    soundChangesText: state.rules,
    romanization: { languageId: state.langId, rules: state.romRules },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `${state.langId || 'language'}.json`; a.click();
});
document.getElementById('copy-btn').addEventListener('click', async () => {
  await navigator.clipboard.writeText(document.getElementById('export-out').value);
  const h = document.getElementById('copy-hint'); h.textContent = 'copied';
  setTimeout(() => h.textContent = '', 1200);
});

/* ─────────────────────  Lexicon  ───────────────────── */
function renderLexicon() {
  const q = (document.getElementById('lex-search').value || '').toLowerCase();
  const posFilter = document.getElementById('lex-pos-filter').value;
  const filtered = state.lexicon.filter(e => {
    if (q && !(e.concept.toLowerCase().includes(q) || e.lemma.toLowerCase().includes(q))) return false;
    if (posFilter && e.pos !== posFilter) return false;
    return true;
  });
  const tbody = document.getElementById('lex-tbody');
  const romMap = { languageId: state.langId, rules: state.romRules };
  tbody.innerHTML = '';
  for (const e of filtered) {
    const tr = document.createElement('tr');
    const links = state.wordlinks.filter(l =>
      (l.langA === state.langId && l.conceptA === e.concept) ||
      (l.langB === state.langId && l.conceptB === e.concept));
    const linkBadge = links.length
      ? `<span class="link-badge" title="${links.length} wordlink${links.length===1?'':'s'}">${links.length}🔗</span>`
      : '';
    tr.innerHTML = `
      <td>${escapeHtml(e.concept)} ${linkBadge}</td>
      <td class="accent">${escapeHtml(e.lemma)}</td>
      <td class="muted">${escapeHtml(state.romRules.length ? romanize(e.lemma, romMap) : '—')}</td>
      <td>${e.pos ? `<span class="pos-tag">${escapeHtml(e.pos)}</span>` : '<span class="muted">—</span>'}</td>
      <td class="muted">${escapeHtml(e.register || 'neutral')}</td>
      <td class="muted">${escapeHtml(e.gloss || '')}</td>
      <td class="right-actions"><button class="btn" data-del="${escapeHtml(e.concept)}">×</button></td>`;
    tbody.appendChild(tr);
    if (links.length) {
      const expandTr = document.createElement('tr');
      expandTr.className = 'lex-links-row';
      expandTr.innerHTML = `<td colspan="7" class="lex-links-cell">${
        links.map(l => {
          const other = l.langA === state.langId
            ? { lang: l.langB, concept: l.conceptB }
            : { lang: l.langA, concept: l.conceptA };
          const otherEntry = (state.languages[other.lang]?.lexicon ?? []).find(x => x.concept === other.concept);
          const lemma = otherEntry?.lemma ?? '?';
          return `<span class="wordlink-chip" data-lang="${escapeHtml(other.lang)}" data-concept="${escapeHtml(other.concept)}" title="${escapeHtml(l.note ?? '')}">
            <span class="kind kind-${l.kind}">${l.kind}</span>
            <span class="lang">${escapeHtml(other.lang)}</span>
            <span class="lemma mono">${escapeHtml(lemma)}</span>
          </span>`;
        }).join('')
      }</td>`;
      tbody.appendChild(expandTr);
    }
  }
  // Click a wordlink chip → jump to that language and search the concept.
  tbody.querySelectorAll('.wordlink-chip').forEach(el => {
    el.addEventListener('click', () => {
      const targetLang = el.dataset.lang;
      const targetConcept = el.dataset.concept;
      if (targetLang !== state.langId) {
        snapshotActiveLanguage();
        loadLanguageSnapshot(targetLang);
      }
      document.getElementById('lex-search').value = targetConcept;
      saveState(); renderAll();
    });
  });
  // Meta line: total + breakdown by POS
  const total = state.lexicon.length;
  const posCounts = {};
  for (const l of state.lexicon) {
    const p = l.pos || 'untagged';
    posCounts[p] = (posCounts[p] || 0) + 1;
  }
  const summary = Object.entries(posCounts).sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `${n} ${p}`).join(' · ');
  document.getElementById('lex-meta').textContent =
    total === 0 ? '0 entries' : `${total} entries · ${summary}`;
  document.getElementById('t-words').textContent = total;
  tbody.querySelectorAll('button[data-del]').forEach(b =>
    b.addEventListener('click', () => {
      state.lexicon = state.lexicon.filter(x => x.concept !== b.dataset.del);
      saveState(); renderLexicon(); renderSoundChanges();
    }));
}
/* ─────────────────────  L20 — Loanword adapter  ───────────────────── */
function buildPhonotacticSpec() {
  const phono = buildPhonologyJson();
  const vs = new Set(CARDINAL_VOWELS.map(v => v.ipa));
  const vowels = [...state.selected].filter(x => vs.has(x));
  // Honour the user's syllable-structure typology choice (state.typology.syllable);
  // fall back to a permissive default for conlangs that haven't set it yet.
  const SYLLABLE_TEMPLATES = {
    cv:      ['CV'],
    cvc:     ['CV', 'CVC'],
    ccvcc:   ['CV', 'CVC', 'CCV', 'CCVC', 'CVCC', 'CCVCC'],
    complex: ['CV', 'CVC', 'CCV', 'CCVC', 'CVCC', 'CCVCC', 'CCCVC', 'CVCCC'],
  };
  const choice = state.typology?.syllable;
  const templates = SYLLABLE_TEMPLATES[choice] ?? ['CV', 'CVC'];
  return {
    spec: { phonologyId: phono.languageId, vowels, syllable: { templates } },
    phono,
  };
}

function renderLoanOtherLangs() {
  const sel = document.getElementById('loan-other-lang');
  if (!sel) return;
  const langs = Object.keys(state.languages || {}).filter(id => id !== state.langId);
  sel.innerHTML = langs.length
    ? langs.map(id => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join('')
    : '<option value="">(no other conlangs)</option>';
}

function renderLoanResults(results) {
  const host = document.getElementById('loan-results');
  if (!host) return;
  if (!results || results.length === 0) {
    host.innerHTML = '<div class="hint">Type some words and click Adapt to see the conlang version.</div>';
    return;
  }
  const KIND_COLORS = { 'substitute': '#e08a3c', 'insert-vowel': '#4caf6d', 'delete': '#d44a4a', 'transpose': '#7aa0d9' };
  const parts = [];
  for (const r of results) {
    if (r.error) {
      parts.push(`<div class="loan-card" style="border:1px solid #d44a4a55; border-radius:6px; padding:10px; margin-bottom:10px">
        <div class="muted">${escapeHtml(r.source)}</div>
        <div style="color:#d44a4a">Error: ${escapeHtml(r.error)}</div>
      </div>`);
      continue;
    }
    const steps = r.steps.map((s, i) => `
      <li style="margin:2px 0; padding-left:4px; border-left:3px solid ${KIND_COLORS[s.kind] ?? '#888'}">
        <span class="muted" style="font-size:11px">${i + 1}.</span>
        <span style="color:${KIND_COLORS[s.kind] ?? '#888'}; font-weight:600; font-size:11px; text-transform:uppercase">${escapeHtml(s.kind)}</span>
        ${escapeHtml(s.reason)}
      </li>`).join('');
    parts.push(`<div class="loan-card" data-idx="${r.idx}" style="border:1px solid #2a2a2a; border-radius:6px; padding:10px; margin-bottom:10px">
      <div class="row" style="align-items:baseline; justify-content:space-between">
        <div>
          <span class="muted" style="font-size:12px">${escapeHtml(r.source)} →</span>
          <span style="font-family: var(--font-ipa, var(--font-mono)); font-size:18px; margin-left:6px">${escapeHtml(r.adapted)}</span>
          ${r.romanized ? `<span class="muted" style="margin-left:8px">⟨${escapeHtml(r.romanized)}⟩</span>` : ''}
        </div>
        <button class="btn primary" data-loan-save="${r.idx}">Save to lexicon as borrowing</button>
      </div>
      ${r.steps.length ? `<ol style="margin:8px 0 0; padding-left:18px; font-size:12px; list-style:none">${steps}</ol>`
                       : '<div class="muted" style="font-size:12px; margin-top:6px">No adaptation needed — input already legal.</div>'}
    </div>`);
  }
  host.innerHTML = parts.join('');
  host.querySelectorAll('button[data-loan-save]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.loanSave);
      const r = results[idx];
      if (!r || r.error) return;
      const concept = (prompt('Concept (English gloss) for borrowed word:', r.source) || '').trim();
      if (!concept) return;
      const existing = state.lexicon.findIndex(e => e.concept === concept);
      const entry = {
        concept,
        lemma: r.adapted,
        ipa: r.adapted,
        pos: 'noun',
        register: 'neutral',
        etymology: `borrowed from "${r.source}"`,
      };
      if (existing >= 0) state.lexicon[existing] = entry; else state.lexicon.push(entry);
      // Source-conlang wordlink if applicable
      const from = document.getElementById('loan-from').value;
      if (from === 'other') {
        const otherLang = document.getElementById('loan-other-lang').value;
        if (otherLang && state.languages?.[otherLang]) {
          // Find source concept in the other language's lexicon (best-effort by lemma match)
          const otherEntry = (state.languages[otherLang].lexicon ?? [])
            .find(e => e.lemma === r.source || e.concept === r.source || e.concept === concept);
          if (otherEntry) {
            const link = { langA: state.langId, conceptA: concept, langB: otherLang, conceptB: otherEntry.concept, kind: 'borrowing' };
            const dup = state.wordlinks.find(l =>
              (l.langA === link.langA && l.conceptA === link.conceptA && l.langB === link.langB && l.conceptB === link.conceptB) ||
              (l.langA === link.langB && l.conceptA === link.conceptB && l.langB === link.langA && l.conceptB === link.conceptA));
            if (!dup) state.wordlinks.push(link);
          }
        }
      }
      saveState();
      renderAffected(['lexicon', 'wordlinks']);
      btn.textContent = '✓ Saved';
      btn.disabled = true;
    });
  });
}

function runLoanwordAdapt() {
  const raw = (document.getElementById('loan-input').value || '').trim();
  if (!raw) return;
  const from = document.getElementById('loan-from').value;
  const { spec, phono } = buildPhonotacticSpec();
  if (spec.vowels.length === 0 || phono.phonemes.length === 0) {
    document.getElementById('loan-results').innerHTML = '<div class="hint">Select at least one vowel and one consonant in the Phonology tab first.</div>';
    return;
  }
  const romMap = state.romRules.length ? { languageId: state.langId, rules: state.romRules } : undefined;
  const adapter = createLoanwordAdapter(phono, spec, { romanization: romMap });
  const words = raw.split(/\s+/).filter(Boolean);
  const results = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    try {
      // For IPA mode, leave the source string as-is. For 'other' conlang, we
      // accept their lemma as IPA (since lexicon stores IPA in `lemma`).
      const input = w;
      const r = adapter.adapt(input);
      results.push({ idx: i, source: w, ...r });
    } catch (e) {
      results.push({ idx: i, source: w, error: e?.message || String(e) });
    }
  }
  renderLoanResults(results);
}

(function initLoanwordUI() {
  const adaptBtn = document.getElementById('loan-adapt');
  if (!adaptBtn) return;
  adaptBtn.addEventListener('click', runLoanwordAdapt);
  document.getElementById('loan-from').addEventListener('change', () => {
    const from = document.getElementById('loan-from').value;
    document.getElementById('loan-other-wrap').style.display = from === 'other' ? '' : 'none';
    renderLoanOtherLangs();
  });
  renderLoanOtherLangs();
})();

document.getElementById('lex-add').addEventListener('click', () => {
  const concept = document.getElementById('lex-concept').value.trim();
  const lemma = document.getElementById('lex-lemma').value.trim();
  if (!concept || !lemma) return;
  const idx = state.lexicon.findIndex(e => e.concept === concept);
  const pos = document.getElementById('lex-pos').value || undefined;
  const entry = {
    concept, lemma, ipa: lemma,
    pos,
    register: document.getElementById('lex-register').value,
    gloss: document.getElementById('lex-gloss').value.trim() || undefined,
  };
  if (idx >= 0) state.lexicon[idx] = entry; else state.lexicon.push(entry);
  document.getElementById('lex-concept').value = '';
  document.getElementById('lex-lemma').value = '';
  document.getElementById('lex-gloss').value = '';
  saveState(); renderLexicon(); renderSoundChanges();
});
document.getElementById('lex-search').addEventListener('input', renderLexicon);
document.getElementById('lex-pos-filter').addEventListener('change', renderLexicon);
document.getElementById('lex-clear').addEventListener('click', () => {
  if (!confirm('Clear the entire lexicon?')) return;
  state.lexicon = []; saveState(); renderAffected(['lexicon']);
});
document.getElementById('lex-autogen').addEventListener('click', () => {
  const phono = buildPhonologyJson();
  const sel = [...state.selected];
  const cs = new Set([...PULMONIC_CONSONANTS, ...NON_PULMONIC_CONSONANTS].map(c => c.ipa));
  const vs = new Set(CARDINAL_VOWELS.map(v => v.ipa));
  const consonants = sel.filter(x => cs.has(x));
  const vowels = sel.filter(x => vs.has(x));
  if (consonants.length === 0 || vowels.length === 0) {
    alert('select at least one consonant and one vowel in the phonology first.');
    return;
  }
  // Seeded sample lexicon — each concept tagged with its natural POS so the
  // Translator (L10) and grammar engine (L11) have something to work with.
  const sample = [
    ['mountain','noun'], ['river','noun'], ['sun','noun'], ['moon','noun'],
    ['star','noun'], ['fire','noun'], ['water','noun'], ['stone','noun'],
    ['wind','noun'], ['sky','noun'], ['child','noun'], ['house','noun'],
    ['road','noun'], ['spirit','noun'], ['word','noun'],
    ['to-walk','verb'], ['to-speak','verb'], ['to-see','verb'], ['to-eat','verb'], ['to-give','verb'],
    ['big','adjective'], ['small','adjective'], ['red','adjective'], ['cold','adjective'],
    ['I','pronoun'], ['you','pronoun'], ['they','pronoun'],
    ['the','determiner'], ['this','determiner'],
    ['and','conjunction'], ['but','conjunction'],
    ['in','preposition'], ['from','preposition'],
    ['one','numeral'], ['two','numeral'], ['three','numeral'],
  ];
  for (const [concept, pos] of sample) {
    if (state.lexicon.some(e => e.concept === concept)) continue;
    try {
      const lemma = generatePhonotacticName({
        phonology: phono,
        phonotactics: { phonologyId: phono.languageId, vowels,
          syllable: { templates: ['CV', 'CVC'] } },
        profile: { syllableTemplate: 'CV', vowels, onsetPool: consonants },
        syllableCount: pos === 'pronoun' || pos === 'determiner' || pos === 'preposition' || pos === 'conjunction' ? 1 : 2,
        seed: deriveSeed(7777n, concept, state.langId),
        category: pos === 'verb' ? 'concept' : 'object',
        instance: concept,
      });
      state.lexicon.push({ concept, lemma, ipa: lemma, pos, register: 'neutral' });
    } catch {}
  }
  saveState(); renderAffected(['lexicon']);
});

/* ─────────────────────  Sound changes  ───────────────────── */
document.getElementById('sca-rules').addEventListener('input', e => {
  state.rules = e.target.value; saveState(); renderSoundChanges();
});
document.getElementById('sca-apply').addEventListener('click', () => {
  try {
    const rules = parseRules(state.rules);
    state.rules += ''; saveState();
    const statusEl = document.getElementById('sca-status');
    statusEl.style.color = 'var(--status-green)';
    statusEl.textContent = `parsed ${rules.length} rule${rules.length===1?'':'s'} — preview below.`;
    renderSoundChanges();
  } catch (e) {
    const statusEl = document.getElementById('sca-status');
    statusEl.style.color = 'var(--status-red)';
    statusEl.textContent = String(e.message ?? e);
  }
});

// Fork: derive a daughter language with these sound changes applied + auto-cognates back to parent.
function forkActiveLanguageAsDaughter() {
  if (state.lexicon.length === 0) {
    alert('Add some words to the lexicon before forking.');
    return;
  }
  const parentRules = state.rules.trim();
  if (!parentRules) {
    alert('Type at least one sound-change rule in the Sound Changes panel before forking.');
    return;
  }
  const newId = prompt('Daughter language ID:', `${state.langId}-daughter`);
  if (!newId || !newId.trim()) return;
  if (state.languages[newId.trim()] || newId.trim() === state.langId) {
    alert('That language ID is already in use.'); return;
  }
  const daughterId = newId.trim();
  // Compute evolved lexicon under the parent context.
  const phono = buildPhonologyJson();
  const sel = [...state.selected];
  const cs = new Set([...PULMONIC_CONSONANTS, ...NON_PULMONIC_CONSONANTS].map(c => c.ipa));
  const vs = new Set(CARDINAL_VOWELS.map(v => v.ipa));
  const vowels = sel.filter(x => vs.has(x));
  const consonants = sel.filter(x => cs.has(x));
  const nasals = [...PULMONIC_CONSONANTS].filter(c => c.manner === 'nasal' && state.selected.has(c.ipa)).map(c => c.ipa);
  const classes = { V: new Set(vowels), C: new Set(consonants), nasal: new Set(nasals) };
  let evolved;
  try {
    evolved = evolveLexicon(
      state.lexicon.map(e => ({ concept: e.concept, lemma: e.lemma })),
      phono, parseRules(parentRules), classes,
    );
  } catch (err) {
    alert('Could not apply rules: ' + (err.message ?? err)); return;
  }
  // Snapshot parent, prepare daughter snapshot (inherits inventory + romanization + grammar
  // but starts with the evolved lexicon and an empty rule stack of its own).
  snapshotActiveLanguage();
  const parentId = state.langId;
  const daughterLexicon = evolved.map(e => {
    const parentEntry = state.lexicon.find(p => p.concept === e.concept);
    return {
      concept: e.concept,
      lemma: e.evolved,
      ipa: e.evolved,
      pos: parentEntry?.pos,
      register: parentEntry?.register ?? 'neutral',
      gloss: parentEntry?.gloss,
      etymology: `< ${parentId} ${e.lemma}`,
    };
  });
  state.languages[daughterId] = {
    selected: [...state.selected],
    lexicon: daughterLexicon,
    rules: '',
    romRules: [...state.romRules],
    grammar: state.grammar,
  };
  // Auto-cognate every parent ↔ daughter pair.
  const cognates = autoCognatesFromDiachrony(parentId, daughterId, evolved);
  for (const link of cognates) {
    // De-duplicate.
    const exists = state.wordlinks.find(l =>
      l.langA === link.langA && l.conceptA === link.conceptA &&
      l.langB === link.langB && l.conceptB === link.conceptB);
    if (!exists) state.wordlinks.push(link);
  }
  // Switch to the daughter.
  loadLanguageSnapshot(daughterId);
  saveState(); renderAll();
  alert(`Forked "${daughterId}" with ${cognates.length} cognate link${cognates.length === 1 ? '' : 's'} back to "${parentId}". Switched to the daughter.`);
}
document.getElementById('sca-fork').addEventListener('click', forkActiveLanguageAsDaughter);
document.getElementById('ft-fork').addEventListener('click', forkActiveLanguageAsDaughter);

/* ───── Visual SCA builder (L16) ─────
   A rule-row holds an AST (target / replacement / before[] / after[]).
   Whenever any chip changes we stringify the whole list back into
   `state.rules` so the existing engine + preview keep working unchanged. */
let scaMode = 'text';          // 'text' | 'visual'
let scaVisualAst = [];         // SoundChangeRule[] when in visual mode

function emptyRule() {
  return { target: '', replacement: '', before: [], after: [], source: '' };
}
function ruleIsRenderable(r) {
  // Only stringify rules with both target + replacement filled in. Until
  // the user has picked both, the rule is a draft and we skip it from text.
  return !!r.target && !!r.replacement;
}
function syncVisualToState() {
  // Stringify every renderable rule; drafts stay as comments so they
  // survive a text/visual toggle without breaking parseRules().
  const lines = scaVisualAst.map(r =>
    ruleIsRenderable(r) ? stringifyRule(r) : '// (draft rule)'
  );
  state.rules = lines.join('\n');
  saveState();
  renderSoundChanges();
}

document.querySelectorAll('#sca-mode-toggle button').forEach(btn => {
  btn.addEventListener('click', () => {
    const next = btn.dataset.mode;
    if (next === scaMode) return;
    const errEl = document.getElementById('sca-mode-err');
    errEl.style.display = 'none'; errEl.textContent = '';
    if (next === 'visual') {
      // Text → AST. If it fails, refuse the switch and surface the error.
      try {
        scaVisualAst = state.rules.trim() === '' ? [] : parseRules(state.rules);
      } catch (e) {
        errEl.textContent = 'Cannot parse rules: ' + (e.message ?? e) + ' — fix in text mode first.';
        errEl.style.display = '';
        return;
      }
    }
    scaMode = next;
    document.querySelectorAll('#sca-mode-toggle button').forEach(b =>
      b.classList.toggle('on', b.dataset.mode === scaMode));
    document.getElementById('sca-text-mode').style.display = scaMode === 'text' ? '' : 'none';
    document.getElementById('sca-visual-mode').style.display = scaMode === 'visual' ? '' : 'none';
    if (scaMode === 'visual') renderSCAVisual();
  });
});

document.getElementById('sca-add-rule').addEventListener('click', () => {
  scaVisualAst.push(emptyRule());
  renderSCAVisual();
});

function getInventoryByManner() {
  // Group the active inventory by manner for the popover phoneme picker.
  const sel = state.selected;
  const groups = { nasal: [], plosive: [], fricative: [], approximant: [], vowel: [], other: [] };
  for (const c of [...PULMONIC_CONSONANTS, ...NON_PULMONIC_CONSONANTS]) {
    if (!sel.has(c.ipa)) continue;
    const m = c.manner;
    if (m === 'nasal' || m === 'plosive' || m === 'fricative' || m === 'approximant') groups[m].push(c.ipa);
    else groups.other.push(c.ipa);
  }
  for (const v of CARDINAL_VOWELS) {
    if (sel.has(v.ipa)) groups.vowel.push(v.ipa);
  }
  return groups;
}

const FEATURE_CLASSES = ['[V]', '[C]', '[nasal]', '[stop]', '[fricative]', '[liquid]'];

/** Open the chip popover. `slot` is one of 'target'|'replacement'|'before'|'after'.
 *  For context slots ('before'/'after') the chip stores a comma-joined token list. */
function openChipPopover(anchor, rule, slot) {
  openPopoverAt(anchor, pop => {
    pop.classList.add('sca-pop');
    const isCtx = slot === 'before' || slot === 'after';
    const isReplacement = slot === 'replacement';
    const groups = getInventoryByManner();
    const sectionHtml = [];

    // Special tokens row depends on slot.
    const specials = [];
    if (isReplacement || slot === 'target') {
      if (isReplacement) specials.push({ tok: '0', label: '0 (delete)' });
    }
    if (isCtx) {
      specials.push({ tok: '#', label: '# (word edge)' });
    }
    if (specials.length) {
      sectionHtml.push(`<div class="pop-section">
        <div class="pop-label">special</div>
        <div class="pop-grid">${
          specials.map(s => `<button class="pop-tok" data-pick="${escapeHtml(s.tok)}">${escapeHtml(s.label)}</button>`).join('')
        }</div></div>`);
    }

    // Feature classes (target / context only; replacement allows them too).
    sectionHtml.push(`<div class="pop-section">
      <div class="pop-label">feature class</div>
      <div class="pop-grid">${
        FEATURE_CLASSES.map(fc => `<button class="pop-tok" data-pick="${escapeHtml(fc)}">${escapeHtml(fc)}</button>`).join('')
      }</div>
      <input class="input mono" id="sca-pop-feat" placeholder="custom: [+nasal]" style="margin-top:4px">
    </div>`);

    // Phonemes grouped by manner.
    const groupOrder = [['nasal', 'nasal'], ['plosive', 'stop'], ['fricative', 'fricative'],
                       ['approximant', 'approximant'], ['vowel', 'vowel'], ['other', 'other']];
    const phonRows = groupOrder
      .filter(([k]) => groups[k] && groups[k].length)
      .map(([k, label]) => `
        <div class="pop-grouplabel">${label}</div>
        <div class="pop-grid">${
          groups[k].map(ipa => `<button class="pop-tok" data-pick="${escapeHtml(ipa)}">${escapeHtml(ipa)}</button>`).join('')
        }</div>`).join('');
    if (phonRows) {
      sectionHtml.push(`<div class="pop-section">
        <div class="pop-label">phoneme (inventory)</div>
        ${phonRows}
      </div>`);
    } else {
      sectionHtml.push(`<div class="pop-section"><div class="pop-label">phoneme</div><div class="hint">add phonemes to the inventory first.</div></div>`);
    }

    if (isCtx) {
      sectionHtml.push(`<div class="pop-section">
        <div class="pop-label">context (append; existing tokens stay)</div>
        <div class="row" style="gap:6px">
          <button class="btn" id="sca-pop-clear">clear</button>
          <span class="hint" style="margin:0">current: <span class="mono">${
            (slot === 'before' ? rule.before : rule.after).join(' ') || '∅'
          }</span></span>
        </div>
      </div>`);
    }

    pop.innerHTML = sectionHtml.join('');

    const commit = (tok) => {
      if (isCtx) {
        const arr = slot === 'before' ? rule.before : rule.after;
        arr.push(tok);
      } else {
        rule[slot] = tok;
      }
      closePopover();
      syncVisualToState();
      renderSCAVisual();
    };

    pop.querySelectorAll('.pop-tok').forEach(b => {
      b.addEventListener('click', () => commit(b.dataset.pick));
    });
    const featIn = pop.querySelector('#sca-pop-feat');
    if (featIn) {
      featIn.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          let v = featIn.value.trim();
          if (!v) return;
          if (!v.startsWith('[')) v = '[' + v;
          if (!v.endsWith(']')) v = v + ']';
          commit(v);
        }
      });
    }
    const clr = pop.querySelector('#sca-pop-clear');
    if (clr) {
      clr.addEventListener('click', () => {
        if (slot === 'before') rule.before = []; else rule.after = [];
        closePopover();
        syncVisualToState();
        renderSCAVisual();
      });
    }
  });
}

function renderSCAVisual() {
  const host = document.getElementById('sca-visual-list');
  host.innerHTML = '';
  scaVisualAst.forEach((rule, idx) => {
    const row = document.createElement('div');
    row.className = 'sca-rule-row';
    const mkChip = (text, filled, slot, placeholder) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sca-chip' + (filled ? ' filled' : '');
      b.textContent = filled ? text : placeholder;
      b.addEventListener('click', () => openChipPopover(b, rule, slot));
      return b;
    };
    row.appendChild(mkChip(rule.target, !!rule.target, 'target', 'target'));
    const arr = document.createElement('span'); arr.className = 'sep'; arr.textContent = '→'; row.appendChild(arr);
    row.appendChild(mkChip(rule.replacement, !!rule.replacement, 'replacement', 'replacement'));
    const sl = document.createElement('span'); sl.className = 'sep'; sl.textContent = '/'; row.appendChild(sl);
    row.appendChild(mkChip(rule.before.join(' '), rule.before.length > 0, 'before', '(before)'));
    const un = document.createElement('span'); un.className = 'sep'; un.textContent = '_'; row.appendChild(un);
    row.appendChild(mkChip(rule.after.join(' '), rule.after.length > 0, 'after', '(after)'));
    const del = document.createElement('button');
    del.className = 'row-del'; del.type = 'button'; del.title = 'remove rule';
    del.textContent = '×';
    del.addEventListener('click', () => {
      scaVisualAst.splice(idx, 1);
      syncVisualToState();
      renderSCAVisual();
    });
    row.appendChild(del);
    host.appendChild(row);
  });
  if (scaVisualAst.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = 'no rules yet — click "+ add rule".';
    host.appendChild(empty);
  }
}

function renderSoundChanges() {
  // Text mode mirrors state.rules into the textarea; visual mode mirrors AST.
  document.getElementById('sca-rules').value = state.rules;
  if (scaMode === 'visual') renderSCAVisual();
  let rules = [];
  try { rules = parseRules(state.rules); } catch {}
  document.getElementById('sca-meta').textContent = `${rules.length} rule${rules.length===1?'':'s'}`;
  document.getElementById('t-rules').textContent = rules.length;
  const tbody = document.getElementById('sca-tbody');
  tbody.innerHTML = '';
  if (state.lexicon.length === 0) {
    document.getElementById('sca-empty').style.display = '';
    document.getElementById('sca-pmeta').textContent = '—';
    return;
  }
  document.getElementById('sca-empty').style.display = 'none';
  const phono = buildPhonologyJson();
  const sel = [...state.selected];
  const cs = new Set([...PULMONIC_CONSONANTS, ...NON_PULMONIC_CONSONANTS].map(c => c.ipa));
  const vs = new Set(CARDINAL_VOWELS.map(v => v.ipa));
  const consonants = sel.filter(x => cs.has(x));
  const vowels = sel.filter(x => vs.has(x));
  const nasals = [...PULMONIC_CONSONANTS].filter(c => c.manner === 'nasal' && state.selected.has(c.ipa)).map(c => c.ipa);
  const classes = {
    V: new Set(vowels), C: new Set(consonants), nasal: new Set(nasals),
  };
  let evolved = [];
  try {
    evolved = evolveLexicon(
      state.lexicon.map(e => ({ concept: e.concept, lemma: e.lemma })),
      phono, rules, classes,
    );
  } catch (err) {
    document.getElementById('sca-pmeta').textContent = 'error: ' + (err.message ?? err);
    return;
  }
  let changed = 0;
  for (const e of evolved) {
    const tr = document.createElement('tr');
    const diff = e.lemma !== e.evolved;
    if (diff) changed++;
    tr.innerHTML = `
      <td>${escapeHtml(e.concept)}</td>
      <td class="muted">${escapeHtml(e.lemma)}</td>
      <td class="${diff ? 'accent' : 'muted'}">→</td>
      <td class="${diff ? 'accent' : ''}">${escapeHtml(e.evolved)}</td>`;
    tbody.appendChild(tr);
  }
  document.getElementById('sca-pmeta').textContent = `${changed}/${evolved.length} changed`;
}

/* ─────────────────────  Romanization  ───────────────────── */
function renderRomanization() {
  const tbody = document.getElementById('rom-tbody');
  tbody.innerHTML = '';
  for (let i = 0; i < state.romRules.length; i++) {
    const [ipa, spell] = state.romRules[i];
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="accent">${escapeHtml(ipa)}</td>
      <td><input class="input mono" data-edit="${i}" value="${escapeHtml(spell)}" style="width:90%"></td>
      <td class="muted">${escapeHtml(applyToSample(ipa, spell))}</td>
      <td class="muted">${escapeHtml(state.lexicon[0]?.lemma ?? '')}</td>
      <td class="right-actions"><button class="btn" data-rm="${i}">×</button></td>`;
    tbody.appendChild(tr);
  }
  document.getElementById('rom-meta').textContent = `${state.romRules.length} rule${state.romRules.length===1?'':'s'}`;
  tbody.querySelectorAll('input[data-edit]').forEach(inp =>
    inp.addEventListener('input', e => {
      state.romRules[+inp.dataset.edit] = [state.romRules[+inp.dataset.edit][0], e.target.value];
      saveState(); renderRomanizationOutput(); renderLexicon();
    }));
  tbody.querySelectorAll('button[data-rm]').forEach(b =>
    b.addEventListener('click', () => {
      state.romRules.splice(+b.dataset.rm, 1);
      saveState(); renderRomanization(); renderLexicon();
    }));
  renderRomanizationOutput();
}
function applyToSample(ipa, spell) {
  return ipa + ' → ' + spell;
}
function renderRomanizationOutput() {
  const inp = document.getElementById('rom-test');
  if (inp) inp.value = state.romTest;
  const map = { languageId: state.langId, rules: state.romRules };
  document.getElementById('rom-out').textContent = state.romRules.length ? romanize(state.romTest, map) : '—';
}
document.getElementById('rom-defaults').addEventListener('click', () => {
  const sel = [...state.selected];
  state.romRules = defaultRomanization(state.langId, sel).rules.map(r => [r[0], r[1]]);
  saveState(); renderRomanization(); renderLexicon();
});
document.getElementById('rom-clear').addEventListener('click', () => {
  state.romRules = []; saveState(); renderRomanization(); renderLexicon();
});
document.getElementById('rom-test').addEventListener('input', e => {
  state.romTest = e.target.value; saveState(); renderRomanizationOutput();
});

/* ─────────────────────  Translator  ───────────────────── */
// Tiny in-memory lexicon adapter on top of state.lexicon so the translator
// reads/writes through the same array the Lexicon panel renders.
const translatorLex = {
  get(_lang, concept) { return state.lexicon.find(e => e.concept === concept) ?? null; },
  set(_lang, concept, entry) {
    const idx = state.lexicon.findIndex(e => e.concept === concept);
    const row = {
      concept, lemma: entry.lemma, ipa: entry.ipa,
      pos: entry.pos, register: entry.register ?? 'neutral',
      gloss: entry.gloss, etymology: entry.etymology,
    };
    if (idx >= 0) state.lexicon[idx] = row; else state.lexicon.push(row);
  },
  all(_lang) { return state.lexicon.map(e => ({ concept: e.concept, entry: e })); },
};

function buildTranslatorCtx() {
  const phono = buildPhonologyJson();
  const sel = [...state.selected];
  const cs = new Set([...PULMONIC_CONSONANTS, ...NON_PULMONIC_CONSONANTS].map(c => c.ipa));
  const vs = new Set(CARDINAL_VOWELS.map(v => v.ipa));
  const consonants = sel.filter(x => cs.has(x));
  const vowels = sel.filter(x => vs.has(x));
  return {
    languageId: state.langId,
    phonology: phono,
    phonotactics: { phonologyId: phono.languageId, vowels, syllable: { templates: ['CV','CVC'] } },
    lexicon: translatorLex,
    fallbackProfile: { syllableTemplate: 'CV', vowels, onsetPool: consonants.length ? consonants : phono.phonemes.map(p => p.ipa) },
    romanization: { languageId: state.langId, rules: state.romRules },
    seed: deriveSeed(1234n, state.langId),
  };
}

async function runTranslate() {
  const text = document.getElementById('tr-input').value;
  if (!text.trim()) return;
  const sel = [...state.selected];
  const cs = new Set([...PULMONIC_CONSONANTS, ...NON_PULMONIC_CONSONANTS].map(c => c.ipa));
  const vs = new Set(CARDINAL_VOWELS.map(v => v.ipa));
  if (!sel.some(x => cs.has(x)) || !sel.some(x => vs.has(x))) {
    document.getElementById('tr-status').textContent = 'Need at least one consonant and one vowel in the inventory.';
    document.getElementById('tr-status').style.color = 'var(--status-red)';
    return;
  }
  try {
    const sentence = await translate(text, buildTranslatorCtx());
    state.lastTranslation = sentence;
    saveState();
    renderTranslation_(sentence);
    document.getElementById('tr-status').style.color = 'var(--status-green)';
    document.getElementById('tr-status').textContent =
      sentence.generated.length
        ? `Translated · ${sentence.generated.length} new word${sentence.generated.length === 1 ? '' : 's'} added to lexicon`
        : 'Translated · all words already in lexicon';
    renderLexicon(); renderSoundChanges();
  } catch (e) {
    document.getElementById('tr-status').textContent = e.message ?? String(e);
    document.getElementById('tr-status').style.color = 'var(--status-red)';
  }
}

function renderTranslation_(sentence) {
  const out = document.getElementById('tr-output');
  out.innerHTML = '';
  for (const t of sentence.tokens) {
    const span = document.createElement('span');
    span.className = 'tr-tok ' + t.kind + (t.generated ? ' gen' : '');
    span.textContent = t.kind === 'word' ? (t.lemma ?? t.source) : t.source;
    if (t.kind === 'word') {
      span.title = `${t.source} → ${t.lemma} (concept "${t.concept}"${t.pos ? ', ' + t.pos : ''})${t.generated ? ' · auto-generated' : ''}`;
      span.addEventListener('click', () => {
        // Switch to Lexicon view with this concept pre-filtered
        document.getElementById('lex-search').value = t.concept;
        renderLexicon();
        state.view = 'lexicon'; saveState(); renderNav();
      });
    }
    out.appendChild(span);
  }
  // Detail breakdown
  const detail = document.getElementById('tr-detail');
  detail.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'tr-row header';
  header.innerHTML = `<div>Source</div><div>Concept</div><div>POS</div><div>Lemma</div><div>Romanized</div>`;
  detail.appendChild(header);
  for (const t of sentence.tokens) {
    if (t.kind !== 'word') continue;
    const row = document.createElement('div');
    row.className = 'tr-row';
    row.innerHTML = `
      <div class="src">${escapeHtml(t.source)}${t.generated ? '<span class="gen-badge">new</span>' : ''}</div>
      <div>${escapeHtml(t.concept)}</div>
      <div>${t.pos ? `<span class="pos-tag">${escapeHtml(t.pos)}</span>` : '<span class="muted">—</span>'}</div>
      <div class="lemma">${escapeHtml(t.lemma ?? '')}</div>
      <div class="rom">${escapeHtml(t.romanized ?? '—')}</div>`;
    detail.appendChild(row);
  }
  // Romanized output panel
  if (state.romRules.length) {
    document.getElementById('tr-romanized-panel').style.display = '';
    document.getElementById('tr-romanized').textContent = renderRomanized(sentence);
  } else {
    document.getElementById('tr-romanized-panel').style.display = 'none';
  }
  document.getElementById('tr-meta').textContent =
    `${sentence.tokens.filter(t => t.kind === 'word').length} words · ${sentence.generated.length} new`;
}

document.getElementById('tr-translate').addEventListener('click', runTranslate);
document.getElementById('tr-input').addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'Enter') runTranslate();
});
document.getElementById('tr-clear').addEventListener('click', () => {
  document.getElementById('tr-input').value = '';
  document.getElementById('tr-output').innerHTML = '';
  document.getElementById('tr-detail').innerHTML = '<div class="hint">Token breakdown will appear here after translation.</div>';
  document.getElementById('tr-romanized-panel').style.display = 'none';
  document.getElementById('tr-status').textContent = '';
  document.getElementById('tr-meta').textContent = '—';
});

/* ─────────────────────  Grammar / paradigms (L11)  ───────────────────── */

// Populate preset dropdown
const grPresetSelect = document.getElementById('gr-preset');
for (let i = 0; i < PRESET_PARADIGMS.length; i++) {
  const opt = document.createElement('option');
  opt.value = String(i); opt.textContent = PRESET_PARADIGMS[i].name;
  grPresetSelect.appendChild(opt);
}

document.getElementById('gr-load-preset').addEventListener('click', () => {
  const idx = grPresetSelect.value;
  if (idx === '') return;
  const p = PRESET_PARADIGMS[+idx];
  state.grammar = { def: p.def, stem: p.exampleStem, rules: [...p.rules] };
  document.getElementById('gr-stem').value = p.exampleStem;
  saveState(); renderGrammar();
});

document.getElementById('gr-stem').addEventListener('input', e => {
  state.grammar.stem = e.target.value;
  saveState(); renderGrammar();
});

document.getElementById('gr-lex').addEventListener('change', e => {
  const concept = e.target.value;
  if (!concept) return;
  const entry = state.lexicon.find(x => x.concept === concept);
  if (!entry) return;
  state.grammar.stem = entry.lemma;
  document.getElementById('gr-stem').value = entry.lemma;
  saveState(); renderGrammar();
});

document.getElementById('gr-rule-add').addEventListener('click', () => {
  const pos = document.getElementById('gr-rule-pos').value;
  const position = document.getElementById('gr-rule-pos-kind').value;
  const condStr = document.getElementById('gr-rule-cond').value.trim();
  const form = document.getElementById('gr-rule-form').value;
  const priority = Number(document.getElementById('gr-rule-pri').value || 0);
  const condition = {};
  for (const pair of condStr.split(',')) {
    const m = pair.trim().match(/^([^=]+)\s*=\s*(.+)$/);
    if (m) condition[m[1].trim()] = m[2].trim();
  }
  state.grammar.rules.push({ pos, condition, position, form, priority });
  // Reset inputs
  document.getElementById('gr-rule-cond').value = '';
  document.getElementById('gr-rule-form').value = '';
  saveState(); renderGrammar();
});

function renderGrammar() {
  if (typeof closePopover === 'function') closePopover();
  renderGrammarTemplateGallery();
  renderGrammarLemmaChips();
  renderGrammarAxisEditor();

  // Lexicon picker
  const lexSel = document.getElementById('gr-lex');
  lexSel.innerHTML = '<option value="">— pick from lexicon —</option>';
  for (const e of state.lexicon) {
    const opt = document.createElement('option');
    opt.value = e.concept; opt.textContent = `${e.concept} · ${e.lemma}${e.pos ? ' (' + e.pos + ')' : ''}`;
    lexSel.appendChild(opt);
  }
  document.getElementById('gr-stem').value = state.grammar.stem || '';

  // Paradigm table
  const host = document.getElementById('gr-table-host');
  const empty = document.getElementById('gr-empty');
  if (!state.grammar.def || !state.grammar.stem) {
    host.innerHTML = '';
    empty.style.display = '';
    document.getElementById('gr-meta').textContent = 'no paradigm';
  } else {
    empty.style.display = 'none';
    const def = state.grammar.def;
    const rules = state.grammar.rules;
    const cells = buildParadigm(state.grammar.stem, def, rules);
    const conflicts = findRuleConflicts(state.grammar.stem, def, rules);
    const conflictKeys = new Set(conflicts.map(c => JSON.stringify(c.target)));

    const axes = Object.entries(def.axes);
    const rowAxis = axes[0] ?? ['_', ['']];
    const colAxis = axes[1] ?? ['_', ['']];
    const [rowKey, rowVals] = rowAxis;
    const [colKey, colVals] = colAxis;

    const tbl = document.createElement('table');
    tbl.className = 'paradigm-table';
    let thead = '<thead><tr><th></th>';
    for (const v of colVals) thead += `<th>${escapeHtml(v)}</th>`;
    thead += '</tr></thead>';
    tbl.innerHTML = thead;
    const tbody = document.createElement('tbody');
    for (const rv of rowVals) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<th>${escapeHtml(rv)}</th>`;
      for (const cv of colVals) {
        const target = {};
        if (rowKey !== '_') target[rowKey] = rv;
        if (colKey !== '_') target[colKey] = cv;
        const cell = cells.find(c =>
          (rowKey === '_' || c.target[rowKey] === rv) &&
          (colKey === '_' || c.target[colKey] === cv)
        );
        const conflicted = conflictKeys.has(JSON.stringify(target));
        const td = document.createElement('td');
        td.className = cell?.ruleIndices.length
          ? (conflicted ? 'cell-form cell-conflict' : 'cell-form')
          : 'cell-empty';
        td.textContent = cell?.form ?? '—';
        td.title = conflicted
          ? `${cell?.form ?? '—'} · conflict: rules ${cell?.ruleIndices.join(', ')} tied`
          : `${cell?.form ?? '—'}${cell?.ruleIndices.length ? ` · rule #${cell.ruleIndices.join(',')}` : ' · no rule matches'}`;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    host.innerHTML = '';
    host.appendChild(tbl);

    const filled = cells.filter(c => c.ruleIndices.length > 0).length;
    document.getElementById('gr-meta').textContent =
      `${filled}/${cells.length} cells filled${conflicts.length ? ' · ' + conflicts.length + ' conflict' + (conflicts.length === 1 ? '' : 's') : ''}`;
  }

  // Rules table
  const rt = document.getElementById('gr-rules-tbody');
  rt.innerHTML = '';
  for (let i = 0; i < state.grammar.rules.length; i++) {
    const r = state.grammar.rules[i];
    const tr = document.createElement('tr');
    tr.draggable = true;
    tr.dataset.idx = String(i);
    const condStr = Object.entries(r.condition).map(([k, v]) => `${k}=${v}`).join(', ') || '(any)';
    tr.innerHTML = `
      <td class="drag-cell" title="Drag to reorder">⋮⋮</td>
      <td><span class="pos-tag">${escapeHtml(r.pos)}</span></td>
      <td class="mono">${escapeHtml(condStr)}</td>
      <td class="muted">${escapeHtml(r.position)}</td>
      <td class="accent mono">${escapeHtml(r.form || '∅')}</td>
      <td class="mono">${r.priority ?? 0}</td>
      <td class="right-actions"><button class="btn" data-rm="${i}">×</button></td>`;
    rt.appendChild(tr);
  }
  rt.querySelectorAll('button[data-rm]').forEach(b =>
    b.addEventListener('click', () => {
      state.grammar.rules.splice(+b.dataset.rm, 1);
      saveState(); renderGrammar();
    }));
  attachRuleDragHandlers(rt);
  document.getElementById('gr-rules-meta').textContent =
    `${state.grammar.rules.length} rule${state.grammar.rules.length === 1 ? '' : 's'}`;
}

/* Drag-to-reorder for affix-rule rows. The drag image is the row itself; we
   compute the drop index from the pointer position relative to each row's
   midpoint, so the user gets a visual top/bottom hint and the drop never
   misses by one. */
function attachRuleDragHandlers(tbody) {
  let dragIdx = -1;
  tbody.querySelectorAll('tr[draggable]').forEach(tr => {
    tr.addEventListener('dragstart', e => {
      dragIdx = +tr.dataset.idx;
      tr.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Some browsers (Firefox) need data to start the drag.
      try { e.dataTransfer.setData('text/plain', String(dragIdx)); } catch {}
    });
    tr.addEventListener('dragend', () => {
      tr.classList.remove('dragging');
      tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over-top', 'drag-over-bottom'));
      dragIdx = -1;
    });
    tr.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = tr.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over-top', 'drag-over-bottom'));
      tr.classList.add(before ? 'drag-over-top' : 'drag-over-bottom');
    });
    tr.addEventListener('drop', e => {
      e.preventDefault();
      if (dragIdx < 0) return;
      const targetIdx = +tr.dataset.idx;
      const rect = tr.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      let dropIdx = before ? targetIdx : targetIdx + 1;
      if (dragIdx < dropIdx) dropIdx--;
      if (dragIdx === dropIdx) return;
      const arr = state.grammar.rules;
      const [moved] = arr.splice(dragIdx, 1);
      arr.splice(dropIdx, 0, moved);
      saveState(); renderGrammar();
    });
  });
}

/* "Try with…" recent-lemma chips. Show the most recent up-to-10 noun/verb
   lemmas (POS filter; if a language has no POS data we fall back to all
   lemmas). Click loads the lemma as the stem. */
function renderGrammarLemmaChips() {
  const host = document.getElementById('gr-lemma-chips');
  host.innerHTML = '';
  const eligible = [];
  // Walk lexicon backwards so "most recent" comes first.
  for (let i = state.lexicon.length - 1; i >= 0 && eligible.length < 10; i--) {
    const e = state.lexicon[i];
    if (!e || !e.lemma) continue;
    if (e.pos && !['noun', 'verb'].includes(e.pos)) continue;
    eligible.push(e);
  }
  if (eligible.length === 0) {
    host.style.display = 'none';
    return;
  }
  host.style.display = '';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = 'Try with';
  host.appendChild(label);
  for (const e of eligible) {
    const chip = document.createElement('span');
    chip.className = 'lemma-chip' + (e.lemma === state.grammar.stem ? ' active' : '');
    chip.title = e.concept ? `${e.concept} → ${e.lemma}` : e.lemma;
    chip.innerHTML = `<span class="lc-lemma">${escapeHtml(e.lemma)}</span>${e.pos ? `<span class="lc-pos">${escapeHtml(e.pos)}</span>` : ''}`;
    chip.addEventListener('click', () => {
      state.grammar.stem = e.lemma;
      saveState(); renderGrammar();
    });
    host.appendChild(chip);
  }
}

/* Inline axis editor — pills per axis, × on each value, + on each header,
   + axis button to add a new one. All edits go through the pure helpers. */
function renderGrammarAxisEditor() {
  const host = document.getElementById('gr-axis-editor');
  if (!state.grammar.def) {
    host.style.display = 'none';
    host.innerHTML = '';
    return;
  }
  host.style.display = '';
  host.innerHTML = '';
  const label = document.createElement('span');
  label.className = 'axis-label';
  label.textContent = 'Axes';
  host.appendChild(label);

  const axes = Object.entries(state.grammar.def.axes);
  for (const [axisName, values] of axes) {
    const pill = document.createElement('span');
    pill.className = 'axis-pill';
    pill.innerHTML = `<span class="axis-name">${escapeHtml(axisName)}</span>`;
    for (const v of values) {
      const vs = document.createElement('span');
      vs.className = 'axis-val';
      vs.innerHTML = `<span>${escapeHtml(v)}</span><button class="x" title="remove value">×</button>`;
      vs.querySelector('.x').addEventListener('click', ev => {
        ev.stopPropagation();
        state.grammar.def = removeAxisValue(state.grammar.def, axisName, v);
        saveState(); renderGrammar();
      });
      pill.appendChild(vs);
    }
    const addBtn = document.createElement('button');
    addBtn.className = 'axis-add';
    addBtn.textContent = '+';
    addBtn.title = `Add a value to "${axisName}"`;
    addBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      openValuePopover(addBtn, axisName);
    });
    pill.appendChild(addBtn);

    const rmBtn = document.createElement('button');
    rmBtn.className = 'axis-rm';
    rmBtn.textContent = '×';
    rmBtn.title = `Remove the "${axisName}" axis`;
    rmBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      if (!confirm(`Remove the "${axisName}" axis? Cells in this dimension will be lost.`)) return;
      state.grammar.def = removeAxis(state.grammar.def, axisName);
      saveState(); renderGrammar();
    });
    pill.appendChild(rmBtn);
    host.appendChild(pill);
  }

  const newAxisBtn = document.createElement('button');
  newAxisBtn.className = 'axis-add-btn';
  newAxisBtn.textContent = '+ axis';
  newAxisBtn.addEventListener('click', () => openAxisPopover(newAxisBtn));
  host.appendChild(newAxisBtn);
}

/* Popovers - delegated to ./components/popover.js (anchor-scoped + auto-close
   when the anchor is removed from the DOM). The shim below keeps the legacy
   callsite shape: openPopoverAt(anchor, builder) returns the pop element. */
let _activePopoverApi = null;
function closePopover() {
  if (_activePopoverApi) { _activePopoverApi.close(); _activePopoverApi = null; }
  else closeActivePopover();
}
function openPopoverAt(anchor, builder) {
  _activePopoverApi = attachPopover(anchor, pop => builder(pop));
  return _activePopoverApi.el;
}
function openAxisPopover(anchor) {
  openPopoverAt(anchor, pop => {
    pop.innerHTML = `
      <label>Axis name<input class="input mono" id="pop-axis-name" placeholder="e.g. case"></label>
      <label>Values (comma-sep)<input class="input mono" id="pop-axis-vals" placeholder="nom, gen, dat"></label>
      <div class="row"><button class="btn" id="pop-cancel">Cancel</button><button class="btn primary" id="pop-add">Add axis</button></div>`;
    setTimeout(() => pop.querySelector('#pop-axis-name').focus(), 0);
    pop.querySelector('#pop-cancel').addEventListener('click', closePopover);
    pop.querySelector('#pop-add').addEventListener('click', () => {
      const name = pop.querySelector('#pop-axis-name').value.trim();
      const vals = pop.querySelector('#pop-axis-vals').value.split(',').map(s => s.trim()).filter(Boolean);
      if (!name || vals.length === 0) { closePopover(); return; }
      state.grammar.def = addAxis(state.grammar.def, name, vals);
      saveState(); closePopover(); renderGrammar();
    });
  });
}
function openValuePopover(anchor, axisName) {
  openPopoverAt(anchor, pop => {
    pop.innerHTML = `
      <label>New value for <span class="mono">${escapeHtml(axisName)}</span><input class="input mono" id="pop-val" placeholder="e.g. dat"></label>
      <div class="row"><button class="btn" id="pop-cancel">Cancel</button><button class="btn primary" id="pop-add">Add</button></div>`;
    setTimeout(() => pop.querySelector('#pop-val').focus(), 0);
    pop.querySelector('#pop-cancel').addEventListener('click', closePopover);
    const commit = () => {
      const v = pop.querySelector('#pop-val').value.trim();
      if (!v) { closePopover(); return; }
      state.grammar.def = addAxisValue(state.grammar.def, axisName, v);
      saveState(); closePopover(); renderGrammar();
    };
    pop.querySelector('#pop-add').addEventListener('click', commit);
    pop.querySelector('#pop-val').addEventListener('keydown', e => { if (e.key === 'Enter') commit(); });
  });
}

/* Starter template gallery — cards with a 1-row preview of the paradigm. */
function renderGrammarTemplateGallery() {
  const host = document.getElementById('gr-template-gallery');
  host.innerHTML = '';
  for (let i = 0; i < PRESET_PARADIGMS.length; i++) {
    const p = PRESET_PARADIGMS[i];
    const card = document.createElement('div');
    card.className = 'template-card';
    // Preview: pick the first row-axis value, render 3 column-axis variants.
    const axes = Object.entries(p.def.axes);
    const axisSummary = axes.map(([k, vs]) => `${k} · ${vs.length}`).join(' × ');
    let previewHtml = '';
    try {
      const cells = buildParadigm(p.exampleStem, p.def, p.rules);
      const seen = new Set();
      const pick = cells.filter(c => {
        const k = Object.entries(c.target).map(([k, v]) => `${k}=${v}`).join(',');
        if (seen.has(k)) return false;
        seen.add(k);
        return c.ruleIndices.length > 0;
      }).slice(0, 3);
      previewHtml = pick.map(c => {
        const tag = Object.entries(c.target).map(([k, v]) => v).join('.');
        return `<div>${escapeHtml(tag)} → <span class="accent">${escapeHtml(c.form)}</span></div>`;
      }).join('');
      if (!previewHtml) previewHtml = `<div class="muted">${escapeHtml(p.exampleStem)} · ${p.rules.length} rules</div>`;
    } catch {
      previewHtml = `<div class="muted">${escapeHtml(p.exampleStem)} · ${p.rules.length} rules</div>`;
    }
    card.innerHTML = `
      <div class="tc-title">${escapeHtml(p.name)}</div>
      <div class="tc-axes">${escapeHtml(axisSummary)}</div>
      <div class="tc-preview">${previewHtml}</div>`;
    card.addEventListener('click', () => {
      const hasExisting = state.grammar.def && state.grammar.rules.length > 0;
      if (hasExisting && !confirm(`Replace the current paradigm with "${p.name}"? Your existing axes and rules will be discarded.`)) return;
      state.grammar = { def: { pos: p.def.pos, axes: { ...p.def.axes } }, stem: p.exampleStem, rules: [...p.rules] };
      document.getElementById('gr-stem').value = p.exampleStem;
      saveState(); renderGrammar();
    });
    host.appendChild(card);
  }
}

/* ─────────────────────  Name gen  ───────────────────── */
function renderNameGenScratchHint() {
  const el = document.getElementById('ng-scratch-hint');
  if (!el) return;
  const s = state.nameGenScratch;
  if (!s) { el.style.display = 'none'; el.textContent = ''; return; }
  const codaStr = s.coda ? ` + /${s.coda}/` : '';
  el.textContent = `seeded from heatmap: /${s.onset}/${codaStr}`;
  el.style.display = '';
}

// Name Gen click handler moved to views/name-gen.js (NameGenView.init).


/* ─────────────────────  topbar  ───────────────────── */
function renderTopbar() {
  // Multi-language selector
  const sel = document.getElementById('lang-id');
  // Gather all known languages: snapshots + the active one.
  const ids = new Set([state.langId, ...Object.keys(state.languages)]);
  sel.innerHTML = '';
  for (const id of [...ids].sort()) {
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = id;
    if (id === state.langId) opt.selected = true;
    sel.appendChild(opt);
  }
  document.getElementById('t-count').textContent = state.selected.size;
  document.getElementById('t-words').textContent = state.lexicon.length;
  document.getElementById('heatmap-toggle').checked = state.heatmap;
  document.getElementById('heatmap-mode').value = state.heatmapMode;
}

/* ─────────────────────  Family tree (L14)  ───────────────────── */
function renderFamilyTree() {
  const svg = document.getElementById('ft-svg');
  const meta = document.getElementById('ft-meta');
  const empty = document.getElementById('ft-empty');
  if (!svg) return;

  // Note: do NOT mutate state.languages here. Rendering should be a pure read
  // of state. For the active language we derive counts directly from the live
  // editor state (state.selected / state.lexicon); other languages are read
  // from their stored snapshots in state.languages.
  const ids = Array.from(new Set([state.langId, ...Object.keys(state.languages)]));
  const roots = buildFamilyTree(ids, state.wordlinks ?? []);

  meta.textContent = `${ids.length} language${ids.length === 1 ? '' : 's'}`;
  // Only "empty" when there is a single language and no cognate links at all.
  const cognateCount = (state.wordlinks ?? []).filter(l => l.kind === 'cognate').length;
  empty.style.display = (ids.length <= 1 && cognateCount === 0) ? '' : 'none';

  // ─── Layout ───
  // Top-down hierarchical: assign each node an (x, y). y = depth row.
  // x = horizontal slot from an in-order walk of leaves.
  const W_NODE = 170, H_NODE = 62;
  const H_GAP = 32, V_GAP = 90;
  const PAD_X = 24, PAD_Y = 24;

  const flat = []; // { node, depth, x, y }
  let cursor = 0;
  function layout(node, depth) {
    const entry = { node, depth, x: 0, y: PAD_Y + depth * (H_NODE + V_GAP) };
    flat.push(entry);
    if (node.children.length === 0) {
      entry.x = PAD_X + cursor * (W_NODE + H_GAP);
      cursor++;
    } else {
      const childEntries = node.children.map(c => layout(c, depth + 1));
      const minX = childEntries[0].x;
      const maxX = childEntries[childEntries.length - 1].x;
      entry.x = (minX + maxX) / 2;
    }
    return entry;
  }
  for (const r of roots) layout(r, 0);

  const maxDepth = Math.max(0, ...flat.map(e => e.depth));
  const width  = PAD_X + Math.max(1, cursor) * (W_NODE + H_GAP) + PAD_X;
  const height = PAD_Y + (maxDepth + 1) * (H_NODE + V_GAP) - V_GAP + PAD_Y + 24;

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.innerHTML = '';

  const SVGNS = 'http://www.w3.org/2000/svg';
  const accent = 'var(--accent)';
  const borderSoft = 'var(--border-soft)';
  const textSecondary = 'var(--text-secondary)';
  const textColor = 'var(--text-primary, #e6e8ec)';
  const bgPanel = 'var(--bg-panel, #22262e)';

  const byId = new Map(flat.map(e => [e.node.id, e]));

  // ─── Edges (drawn first so nodes overlay them) ───
  for (const e of flat) {
    if (!e.node.parentId) continue;
    const p = byId.get(e.node.parentId);
    if (!p) continue;
    const x1 = p.x + W_NODE / 2;
    const y1 = p.y + H_NODE;
    const x2 = e.x + W_NODE / 2;
    const y2 = e.y;
    const midY = (y1 + y2) / 2;
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', borderSoft);
    path.setAttribute('stroke-width', '1.5');
    svg.appendChild(path);

    if (e.node.ruleSummary) {
      const labelY = midY - 6;
      const summary = document.createElementNS(SVGNS, 'text');
      summary.setAttribute('x', (x1 + x2) / 2);
      summary.setAttribute('y', labelY);
      summary.setAttribute('text-anchor', 'middle');
      summary.setAttribute('fill', textSecondary);
      summary.setAttribute('font-size', '11');
      summary.setAttribute('font-family', "ui-monospace, 'JetBrains Mono', Menlo, monospace");
      summary.textContent = e.node.ruleSummary;
      svg.appendChild(summary);

      if (e.node.sampleChange) {
        const sample = document.createElementNS(SVGNS, 'text');
        sample.setAttribute('x', (x1 + x2) / 2);
        sample.setAttribute('y', labelY + 13);
        sample.setAttribute('text-anchor', 'middle');
        sample.setAttribute('fill', textSecondary);
        sample.setAttribute('font-size', '10');
        sample.setAttribute('font-style', 'italic');
        sample.textContent = `“${e.node.sampleChange.concept}”`;
        svg.appendChild(sample);
      }
    }
  }

  // ─── Nodes ───
  for (const e of flat) {
    const isActive = e.node.id === state.langId;
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('transform', `translate(${e.x}, ${e.y})`);
    g.style.cursor = 'pointer';
    g.addEventListener('click', () => {
      if (e.node.id === state.langId) return;
      snapshotActiveLanguage();
      loadLanguageSnapshot(e.node.id);
      saveState(); renderAll();
    });

    const rect = document.createElementNS(SVGNS, 'rect');
    rect.setAttribute('width', W_NODE);
    rect.setAttribute('height', H_NODE);
    rect.setAttribute('rx', '5');
    rect.setAttribute('ry', '5');
    rect.setAttribute('fill', bgPanel);
    rect.setAttribute('stroke', isActive ? accent : borderSoft);
    rect.setAttribute('stroke-width', isActive ? '2' : '1.5');
    g.appendChild(rect);

    // For the active language, counts come from the live editor state so the
    // node reflects unsaved edits. For other languages, read from the snapshot.
    let phonemes, words;
    if (e.node.id === state.langId) {
      phonemes = (state.selected ?? []).length;
      words = (state.lexicon ?? []).length;
    } else {
      const snap = state.languages[e.node.id] ?? {};
      phonemes = (snap.selected ?? []).length;
      words = (snap.lexicon ?? []).length;
    }

    const idText = document.createElementNS(SVGNS, 'text');
    idText.setAttribute('x', W_NODE / 2);
    idText.setAttribute('y', 24);
    idText.setAttribute('text-anchor', 'middle');
    idText.setAttribute('fill', isActive ? accent : textColor);
    idText.setAttribute('font-size', '13');
    idText.setAttribute('font-weight', '600');
    idText.textContent = e.node.id.length > 22 ? e.node.id.slice(0, 20) + '…' : e.node.id;
    g.appendChild(idText);

    const stats = document.createElementNS(SVGNS, 'text');
    stats.setAttribute('x', W_NODE / 2);
    stats.setAttribute('y', 44);
    stats.setAttribute('text-anchor', 'middle');
    stats.setAttribute('fill', textSecondary);
    stats.setAttribute('font-size', '11');
    stats.textContent = `${phonemes} phoneme${phonemes === 1 ? '' : 's'} · ${words} word${words === 1 ? '' : 's'}`;
    g.appendChild(stats);

    if (isActive) {
      const tag = document.createElementNS(SVGNS, 'text');
      tag.setAttribute('x', W_NODE / 2);
      tag.setAttribute('y', 58);
      tag.setAttribute('text-anchor', 'middle');
      tag.setAttribute('fill', accent);
      tag.setAttribute('font-size', '9.5');
      tag.setAttribute('font-weight', '600');
      tag.setAttribute('letter-spacing', '0.5');
      tag.textContent = 'ACTIVE';
      g.appendChild(tag);
    }

    svg.appendChild(g);
  }
}

/* —— L15 typology renderer —— */
const TYP_CATEGORY_LABELS = {
  'word-order': 'Word order',
  'morphology': 'Morphology',
  'semantics':  'Tense · aspect · semantics',
  'phonology':  'Phonology',
};
function renderTypology() {
  const profile = state.typology ?? (state.typology = {});

  // Summary line + meta
  const summaryEl = document.getElementById('typ-summary');
  const metaEl = document.getElementById('typ-meta');
  if (summaryEl) {
    const s = profileSummary(profile);
    summaryEl.textContent = s || 'no profile set';
  }
  if (metaEl) {
    const set = Object.keys(profile).filter(k => profile[k]).length;
    metaEl.textContent = `${set} / ${TYPOLOGY_FEATURES.length} features set`;
  }

  // Preset dropdown — only build the options once.
  const presetSel = document.getElementById('typ-preset');
  if (presetSel && presetSel.options.length <= 1) {
    for (const name of Object.keys(TYPOLOGY_PRESETS)) {
      const o = document.createElement('option');
      o.value = name; o.textContent = name;
      presetSel.appendChild(o);
    }
  }
  if (presetSel) presetSel.value = '';

  // Category sections + feature cards
  const host = document.getElementById('typ-categories');
  if (!host) return;
  host.innerHTML = '';

  const byCat = new Map();
  for (const f of TYPOLOGY_FEATURES) {
    if (!byCat.has(f.category)) byCat.set(f.category, []);
    byCat.get(f.category).push(f);
  }

  for (const [cat, feats] of byCat.entries()) {
    const title = document.createElement('div');
    title.className = 'typ-cat-title';
    title.textContent = TYP_CATEGORY_LABELS[cat] ?? cat;
    host.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'typ-grid';
    for (const f of feats) {
      const card = document.createElement('div');
      card.className = 'typ-card panel';
      card.style.padding = '10px 12px';
      const label = document.createElement('div');
      label.className = 'typ-label'; label.textContent = f.label;
      const desc = document.createElement('div');
      desc.className = 'typ-desc'; desc.textContent = f.description;
      card.appendChild(label); card.appendChild(desc);

      const opts = document.createElement('div');
      opts.className = 'typ-opts';
      for (const o of f.options) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'typ-opt' + (profile[f.key] === o.value ? ' selected' : '');
        btn.dataset.feature = f.key;
        btn.dataset.option = o.value;

        const top = document.createElement('div');
        top.className = 'typ-opt-top';
        const lbl = document.createElement('span'); lbl.textContent = o.label;
        const freq = document.createElement('span');
        freq.className = 'typ-opt-freq';
        if (typeof o.frequency === 'number') {
          const pct = o.frequency * 100;
          freq.textContent = `~${pct < 1 ? pct.toFixed(1) : pct.toFixed(0)}%`;
        } else {
          freq.textContent = '';
        }
        top.appendChild(lbl); top.appendChild(freq);
        btn.appendChild(top);

        if (typeof o.frequency === 'number') {
          const bar = document.createElement('div');
          bar.className = 'typ-freq-bar';
          const fill = document.createElement('span');
          fill.style.width = `${Math.min(100, o.frequency * 100)}%`;
          bar.appendChild(fill);
          btn.appendChild(bar);
        }

        btn.addEventListener('click', () => {
          if (profile[f.key] === o.value) {
            delete profile[f.key]; // toggle off
          } else {
            profile[f.key] = o.value;
          }
          saveState();
          renderTypology();
          renderPhonology(); // update inv-stats typology tags
        });
        opts.appendChild(btn);
      }
      card.appendChild(opts);
      grid.appendChild(card);
    }
    host.appendChild(grid);
  }
}

/* preset + clear wiring */
(() => {
  const preset = document.getElementById('typ-preset');
  if (preset) preset.addEventListener('change', e => {
    const name = e.target.value;
    if (!name) return;
    const tpl = TYPOLOGY_PRESETS[name];
    if (!tpl) return;
    state.typology = { ...tpl };
    saveState(); renderTypology(); renderPhonology();
  });
  const clear = document.getElementById('typ-clear');
  if (clear) clear.addEventListener('click', () => {
    state.typology = {};
    saveState(); renderTypology(); renderPhonology();
  });
})();

/* View dependency map - each entry lists the state keys a view reads.
   renderAffected(changed) re-renders only the views whose deps intersect. */
const VIEW_RENDERERS = {
  nav: () => renderNav(),
  topbar: () => renderTopbar(),
  phonology: () => renderPhonology(),
  lexicon: () => renderLexicon(),
  rules: () => renderSoundChanges(),
  romanization: () => renderRomanization(),
  grammar: () => renderGrammar(),
  familyTree: () => renderFamilyTree(),
  typology: () => renderTypology(),
  legalityHeatmap: () => renderLegalityHeatmap(),
  statsDashboard: () => renderStatsDashboard(),
  nameGen: () => renderNameGenScratchHint(),
};

const VIEW_DEPS = {
  nav:             ['view'],
  topbar:          ['selected', 'lexicon', 'langId', 'languages', 'heatmap', 'heatmapMode'],
  phonology:       ['selected', 'active', 'heatmap', 'heatmapMode', 'typology'],
  lexicon:         ['lexicon', 'romRules', 'langId', 'wordlinks', 'languages'],
  rules:           ['rules', 'lexicon', 'selected'],
  romanization:    ['romRules', 'romTest', 'lexicon', 'selected', 'langId'],
  grammar:         ['grammar', 'lexicon'],
  familyTree:      ['languages', 'wordlinks', 'langId', 'selected', 'lexicon'],
  typology:        ['typology'],
  legalityHeatmap: ['selected'],
  statsDashboard:  ['selected', 'lexicon', 'typology'],
  nameGen:         ['nameGenScratch'],
};

/** Dirty-flag render: only re-paint views whose deps overlap `changedKeys`.
 *  Replaces the old "everything on every keystroke" renderAll() for fine
 *  state mutations. Use renderAll() for coarse path resets (import, switch
 *  language, preset apply). */
function renderAffected(changedKeys) {
  const changed = new Set(Array.isArray(changedKeys) ? changedKeys : [changedKeys]);
  for (const [view, deps] of Object.entries(VIEW_DEPS)) {
    if (deps.some(d => changed.has(d))) {
      try { VIEW_RENDERERS[view](); } catch (e) { console.error('[renderAffected]', view, e); }
    }
  }
}

function renderAll() {
  for (const fn of Object.values(VIEW_RENDERERS)) {
    try { fn(); } catch (e) { console.error('[renderAll] view failed', e); }
  }
}

// Name Gen click handler lives in ./views/name-gen.js. We pass the engine
// references through ENGINE so the view module stays free of dist/ imports.
NameGenView.init({
  state, saveState,
  deps: { buildPhonologyJson },
  render: renderAffected,
  ENGINE: {
    PULMONIC_CONSONANTS, NON_PULMONIC_CONSONANTS, CARDINAL_VOWELS,
    generatePhonotacticName, romanize,
  },
});

/* ───────── L19 — Phonotactic legality heatmap ───────── */
function renderLegalityHeatmap() {
  const host = document.getElementById('legality-heatmap');
  if (!host) return;
  const phono = buildPhonologyJson();
  const sel = [...state.selected];
  const vs = new Set(CARDINAL_VOWELS.map(v => v.ipa));
  const vowels = sel.filter(x => vs.has(x));
  const consonants = sel.filter(x => !vs.has(x));

  if (vowels.length === 0 || consonants.length === 0) {
    host.innerHTML = '<div class="hint">Add at least one vowel and one consonant to see the legality heatmap.</div>';
    return;
  }

  // Pick a permissive spec — CV + CVC, single-segment slots only — so cells reflect
  // pure (onset, coda) legality rather than cluster ordering.
  const spec = {
    phonologyId: phono.languageId,
    vowels,
    syllable: { templates: ['CV', 'CVC'] },
  };

  const cells = clusterLegality(spec, phono);
  const byKey = new Map();
  for (const c of cells) byKey.set(c.onset + '|' + c.coda, c);

  const colCodas = ['', ...consonants]; // first column is "(no coda)"
  const colW = 34, rowH = 30, headerH = 26, headerW = 38;

  const parts = [];
  parts.push(`<div style="display:inline-grid; grid-template-columns: ${headerW}px repeat(${colCodas.length}, ${colW}px); gap:2px; font-family: var(--font-mono); font-size: 11px">`);
  // header row
  parts.push(`<div style="height:${headerH}px"></div>`);
  for (const coda of colCodas) {
    const label = coda === '' ? '∅' : coda;
    parts.push(`<div style="height:${headerH}px; display:flex; align-items:center; justify-content:center; color:var(--text-muted)" title="${coda === '' ? 'no coda (open syllable)' : 'coda ' + escapeHtml(coda)}">${escapeHtml(label)}</div>`);
  }
  // data rows
  for (const onset of consonants) {
    parts.push(`<div style="height:${rowH}px; display:flex; align-items:center; justify-content:center; color:var(--text-muted)">${escapeHtml(onset)}</div>`);
    for (const coda of colCodas) {
      const cell = byKey.get(onset + '|' + coda);
      if (!cell) {
        parts.push(`<div style="height:${rowH}px; background:var(--bg-base); border:1px solid var(--border-soft)"></div>`);
        continue;
      }
      const bg = cell.legality === 'legal'
        ? 'var(--status-green)'
        : cell.legality === 'restricted'
          ? 'var(--status-orange)'
          : 'var(--bg-base)';
      const border = cell.legality === 'illegal' ? '1px solid var(--border-soft)' : '1px solid transparent';
      const sample = cell.sample ?? '';
      const showSample = cell.legality !== 'illegal';
      const cursor = showSample ? 'pointer' : 'default';
      const tip = cell.legality === 'legal'
        ? `legal · ${sample}`
        : cell.legality === 'restricted'
          ? `restricted · ${cell.reason ?? ''}`
          : `illegal · ${cell.reason ?? ''}`;
      const dataAttrs = showSample
        ? ` data-seed-onset="${escapeHtml(onset)}" data-seed-coda="${escapeHtml(coda)}"`
        : '';
      parts.push(
        `<div class="legality-cell" style="height:${rowH}px; background:${bg}; border:${border}; display:flex; align-items:center; justify-content:center; font-family: var(--font-ipa); font-size: 12px; color: var(--bg-base); cursor:${cursor}" title="${escapeHtml(tip)}"${dataAttrs}>${showSample ? escapeHtml(sample) : ''}</div>`,
      );
    }
  }
  parts.push('</div>');
  host.innerHTML = parts.join('');

  for (const el of host.querySelectorAll('.legality-cell[data-seed-onset]')) {
    el.addEventListener('click', () => {
      const onset = el.dataset.seedOnset;
      const coda = el.dataset.seedCoda;
      const tpl = coda ? 'CVC' : 'CV';
      const tplSel = document.getElementById('ng-tpl');
      if (tplSel) tplSel.value = tpl;
      // Stash a one-shot seed override on state for the name-gen roller to
      // pick up; also switch to the Name Gen tab so the user sees the change.
      // The scratch is cleared after the next roll completes.
      state.nameGenScratch = { onset, coda };
      state.view = 'names'; saveState(); renderNav(); renderNameGenScratchHint();
    });
  }
}

/* —— Inspector pin + sticky shadow —— */
function applyInspectorPin() {
  const inspector = document.getElementById('inspector-panel');
  const btn = document.getElementById('pin-btn');
  if (!inspector || !btn) return;
  inspector.classList.toggle('pinned', state.inspectorPinned);
  btn.setAttribute('aria-pressed', String(state.inspectorPinned));
  btn.title = state.inspectorPinned
    ? 'Pinned · click to unpin (stop following scroll)'
    : 'Unpinned · click to pin (follow scroll)';
}

function setupStickyShadow() {
  const inspector = document.getElementById('inspector-panel');
  const main = document.querySelector('main');
  const btn = document.getElementById('pin-btn');
  if (!inspector || !main || !btn) return;
  const sentinel = document.createElement('div');
  sentinel.style.cssText = 'position: absolute; top: 0; height: 1px; pointer-events: none;';
  inspector.parentElement.style.position = 'relative';
  inspector.parentElement.prepend(sentinel);
  new IntersectionObserver(
    ([entry]) => {
      if (state.inspectorPinned) inspector.classList.toggle('stuck', !entry.isIntersecting);
      else inspector.classList.remove('stuck');
    },
    { root: main, threshold: [1] },
  ).observe(sentinel);
  btn.addEventListener('click', () => {
    state.inspectorPinned = !state.inspectorPinned;
    saveState(); applyInspectorPin();
  });
  applyInspectorPin();
}
setupStickyShadow();

// escapeHtml is imported from ./components/utils.js

/* ───────── L21 — Statistics dashboard ───────── */

// Caching: re-derive only when the lexicon/inventory signature changes.
let _statsCache = null;

function statsSignature() {
  // Cheap fingerprint of the inputs the stats panel depends on.
  const lex = state.lexicon.map(e => `${e.lemma}|${e.pos ?? ''}|${e.register ?? ''}`).join('');
  const sel = [...state.selected].sort().join(',');
  const syl = state.typology?.syllable ?? '';
  return `${sel}::${syl}::${lex}`;
}

function _phonemeManner(ipa) {
  const all = [...PULMONIC_CONSONANTS, ...NON_PULMONIC_CONSONANTS];
  const c = all.find(x => x.ipa === ipa);
  if (c) {
    const m = c.manner;
    if (m === 'nasal') return 'nasal';
    if (m === 'plosive' || m === 'stop' || m === 'affricate' || m === 'implosive' || m === 'ejective' || m === 'click') return 'plosive';
    if (m === 'fricative' || m === 'sibilant-fricative' || m === 'lateral-fricative') return 'fricative';
    if (m === 'approximant' || m === 'lateral-approximant' || m === 'trill' || m === 'tap' || m === 'lateral-tap') return 'approximant';
    return 'other';
  }
  if (CARDINAL_VOWELS.some(v => v.ipa === ipa)) return 'vowel';
  return 'other';
}

const MANNER_COLOR = {
  nasal: 'var(--tag-pink, #b66bb0)',
  plosive: 'var(--tag-blue, #5d8acf)',
  fricative: 'var(--tag-green, #4caf6d)',
  approximant: 'var(--accent, #4dc4c4)',
  vowel: 'var(--status-orange, #e08a3c)',
  other: 'var(--text-muted, #888)',
};

function _svgEscape(s) { return escapeHtml(String(s)); }

function _renderPhonemeBar(stats) {
  const total = [...stats.phonemeFrequency.values()].reduce((a, b) => a + b, 0);
  if (total === 0) {
    return '<div class="hint">No tokenisable lemmas yet. Add a word with phonemes from your inventory.</div>';
  }
  const rows = [...stats.phonemeFrequency.entries()].sort((a, b) => b[1] - a[1]);
  const max = rows[0][1];
  const W = 220, H = 14;
  const parts = [];
  parts.push('<div style="display:flex; flex-direction:column; gap:3px">');
  for (const [ipa, count] of rows) {
    const pct = (count / total) * 100;
    const w = Math.max(2, (count / max) * W);
    const manner = _phonemeManner(ipa);
    const color = MANNER_COLOR[manner];
    const examples = stats.phonemeExamples.get(ipa) ?? [];
    const tip = `${ipa} · ${count} (${pct.toFixed(1)}%)${examples.length ? ' · in: ' + examples.join(', ') : ''}`;
    parts.push(`<div class="row" style="align-items:center; gap:8px" title="${_svgEscape(tip)}">
      <span style="font-family: var(--font-ipa, var(--font-mono)); font-size:13px; width:24px; text-align:right">${_svgEscape(ipa)}</span>
      <svg width="${W}" height="${H}" style="display:block">
        <rect x="0" y="2" width="${w}" height="${H - 4}" rx="2" fill="${color}"></rect>
      </svg>
      <span class="mono" style="font-size:11px; color:var(--text-muted); min-width:60px">${count} · ${pct.toFixed(1)}%</span>
    </div>`);
  }
  parts.push('</div>');
  // legend
  parts.push(`<div class="chart-legend" style="margin-top:8px; font-size:11px">
    <span><span class="sw" style="background:${MANNER_COLOR.nasal}"></span>nasal</span>
    <span><span class="sw" style="background:${MANNER_COLOR.plosive}"></span>plosive</span>
    <span><span class="sw" style="background:${MANNER_COLOR.fricative}"></span>fricative</span>
    <span><span class="sw" style="background:${MANNER_COLOR.approximant}"></span>approximant</span>
    <span><span class="sw" style="background:${MANNER_COLOR.vowel}"></span>vowel</span>
  </div>`);
  return parts.join('');
}

function _renderSyllableShapes(stats) {
  const entries = [...stats.syllableShapeDistribution.entries()].sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((a, [, c]) => a + c, 0);
  if (total === 0) return '<div class="hint">No syllable shapes yet.</div>';
  const W = 320, H = 22;
  const palette = ['var(--tag-blue, #5d8acf)', 'var(--accent, #4dc4c4)', 'var(--tag-green, #4caf6d)',
                   'var(--status-orange, #e08a3c)', 'var(--tag-pink, #b66bb0)', 'var(--text-muted, #888)'];
  let x = 0;
  const segs = [];
  const legends = [];
  for (let i = 0; i < entries.length; i++) {
    const [shape, count] = entries[i];
    const w = (count / total) * W;
    const color = palette[i % palette.length];
    segs.push(`<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="${H}" fill="${color}"><title>${_svgEscape(shape)} · ${count}</title></rect>`);
    legends.push({ shape, count, color, pct: (count / total) * 100 });
    x += w;
  }
  const top = legends.slice(0, 3);
  const caption = top.map(l => `${l.shape} (${l.pct.toFixed(0)}%)`).join(', ');
  return `<svg width="${W}" height="${H}" style="display:block; border-radius:3px; overflow:hidden">${segs.join('')}</svg>
    <div class="chart-legend" style="margin-top:6px; font-size:11px; flex-wrap:wrap; gap:4px 10px">
      ${legends.map(l => `<span><span class="sw" style="background:${l.color}"></span><span class="mono">${_svgEscape(l.shape)}</span> ${l.count}</span>`).join('')}
    </div>
    <div class="hint" style="margin-top:6px">most common: ${_svgEscape(caption)}</div>`;
}

function _renderLengthHistogram(stats) {
  const entries = [...stats.wordLengthHistogram.entries()].sort((a, b) => a[0] - b[0]);
  if (entries.length === 0) return '<div class="hint">No word lengths recorded yet.</div>';
  const minLen = Math.min(1, entries[0][0]);
  const maxLen = Math.max(12, entries[entries.length - 1][0]);
  const bins = [];
  for (let i = minLen; i <= maxLen; i++) {
    bins.push([i, stats.wordLengthHistogram.get(i) ?? 0]);
  }
  const maxCount = Math.max(1, ...bins.map(b => b[1]));
  const barW = 18, gap = 4, H = 90, pad = 14;
  const W = bins.length * (barW + gap);
  // median
  const flat = [];
  for (const [len, c] of bins) for (let i = 0; i < c; i++) flat.push(len);
  flat.sort((a, b) => a - b);
  const median = flat.length === 0 ? 0 : flat.length % 2 === 1
    ? flat[(flat.length - 1) / 2]
    : (flat[flat.length / 2 - 1] + flat[flat.length / 2]) / 2;

  const bars = bins.map(([len, c], i) => {
    const h = c === 0 ? 0 : Math.max(2, (c / maxCount) * (H - pad));
    const x = i * (barW + gap);
    const y = H - h - pad;
    return `<g>
      <rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="2" fill="var(--tag-blue, #5d8acf)"><title>${len} phonemes · ${c} word${c === 1 ? '' : 's'}</title></rect>
      <text x="${x + barW / 2}" y="${H - 2}" font-size="9" text-anchor="middle" fill="var(--text-muted)" font-family="var(--font-mono)">${len}</text>
      ${c > 0 ? `<text x="${x + barW / 2}" y="${y - 2}" font-size="9" text-anchor="middle" fill="var(--text-muted)" font-family="var(--font-mono)">${c}</text>` : ''}
    </g>`;
  }).join('');
  return `<svg width="${W}" height="${H}" style="display:block">${bars}</svg>
    <div class="hint" style="margin-top:6px">
      mean <span class="mono accent">${stats.avgWordLength.toFixed(2)}</span>
      · median <span class="mono accent">${median.toFixed(median % 1 === 0 ? 0 : 1)}</span>
      · C:V <span class="mono accent">${stats.consonantVowelRatio.toFixed(2)}</span>
      ${stats.unparseable > 0 ? `· <span style="color:var(--status-orange, #e08a3c)">${stats.unparseable} unparseable</span>` : ''}
    </div>`;
}

function _renderDonut(map, title, palette) {
  const entries = [...map.entries()].sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((a, [, c]) => a + c, 0);
  if (total === 0) {
    return `<div class="hint"><b style="color:var(--text-primary)">${_svgEscape(title)}</b><br>—</div>`;
  }
  const R = 42, r = 26, cx = 50, cy = 50;
  let a0 = -Math.PI / 2;
  const arcs = entries.map(([key, count], i) => {
    const frac = count / total;
    const a1 = a0 + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    // Force a whole circle for single-slice case (e.g. one POS).
    let d;
    if (entries.length === 1) {
      // Two semicircles to make a ring.
      d = `M ${cx - R} ${cy} A ${R} ${R} 0 1 1 ${cx + R} ${cy} A ${R} ${R} 0 1 1 ${cx - R} ${cy} Z
           M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;
    } else {
      const x0 = cx + R * Math.cos(a0), y0 = cy + R * Math.sin(a0);
      const x1 = cx + R * Math.cos(a1), y1 = cy + R * Math.sin(a1);
      const xr0 = cx + r * Math.cos(a1), yr0 = cy + r * Math.sin(a1);
      const xr1 = cx + r * Math.cos(a0), yr1 = cy + r * Math.sin(a0);
      d = `M ${x0.toFixed(2)} ${y0.toFixed(2)}
           A ${R} ${R} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}
           L ${xr0.toFixed(2)} ${yr0.toFixed(2)}
           A ${r} ${r} 0 ${large} 0 ${xr1.toFixed(2)} ${yr1.toFixed(2)} Z`;
    }
    const color = palette[i % palette.length];
    a0 = a1;
    return { d, color, key, count, frac };
  });
  const svg = `<svg width="100" height="100" viewBox="0 0 100 100" style="display:block">
    ${arcs.map(a => `<path d="${a.d}" fill="${a.color}" fill-rule="evenodd"><title>${_svgEscape(a.key)} · ${a.count} (${(a.frac * 100).toFixed(1)}%)</title></path>`).join('')}
    <text x="50" y="54" text-anchor="middle" font-size="14" font-family="var(--font-mono)" fill="var(--text-primary)">${total}</text>
  </svg>`;
  const legend = arcs.map(a => `<div class="row" style="align-items:center; gap:6px; font-size:11px">
    <span class="sw" style="background:${a.color}; width:10px; height:10px; display:inline-block; border-radius:2px"></span>
    <span style="flex:1">${_svgEscape(a.key)}</span>
    <span class="mono" style="color:var(--text-muted)">${a.count}</span>
  </div>`).join('');
  return `<div><div class="hint" style="margin-bottom:4px"><b style="color:var(--text-primary)">${_svgEscape(title)}</b></div>
    <div class="row" style="align-items:flex-start; gap:10px">
      ${svg}
      <div style="flex:1; display:flex; flex-direction:column; gap:2px; min-width:0">${legend}</div>
    </div></div>`;
}

function renderStatsDashboard() {
  const host = document.getElementById('stats-dashboard');
  if (!host) return;
  if (state.lexicon.length === 0) {
    host.innerHTML = '<div class="hint">No words yet. Add entries in the <b>Lexicon</b> tab to see phoneme balance, syllable shapes and word-length distribution.</div>';
    _statsCache = null;
    return;
  }
  const sig = statsSignature();
  let stats;
  if (_statsCache && _statsCache.sig === sig) {
    stats = _statsCache.stats;
  } else {
    const { spec, phono } = buildPhonotacticSpec();
    if (phono.phonemes.length === 0) {
      host.innerHTML = '<div class="hint">Select an inventory in the chart above first.</div>';
      _statsCache = null;
      return;
    }
    stats = computeLexiconStatistics(state.lexicon, phono, spec);
    _statsCache = { sig, stats };
  }

  const posPalette = ['var(--tag-blue, #5d8acf)', 'var(--tag-green, #4caf6d)', 'var(--accent, #4dc4c4)',
                      'var(--status-orange, #e08a3c)', 'var(--tag-pink, #b66bb0)', 'var(--text-muted, #888)',
                      '#d44a4a', '#7aa0d9', '#b9a04a', '#4caf6d', '#a06bb6'];
  const regPalette = ['var(--accent, #4dc4c4)', 'var(--status-orange, #e08a3c)', 'var(--tag-pink, #b66bb0)',
                      'var(--tag-blue, #5d8acf)', 'var(--text-muted, #888)'];

  host.innerHTML = `
    <div style="display:grid; grid-template-columns: minmax(260px, 1fr) minmax(260px, 1fr); gap: 16px">
      <div>
        <div class="hint" style="margin-bottom:6px"><b style="color:var(--text-primary)">Phoneme frequency</b>
          <span style="color:var(--text-muted)"> · ${stats.parsedCount}/${stats.wordCount} word${stats.wordCount === 1 ? '' : 's'} parsed</span>
        </div>
        ${_renderPhonemeBar(stats)}
      </div>
      <div style="display:flex; flex-direction:column; gap:14px">
        <div>
          <div class="hint" style="margin-bottom:6px"><b style="color:var(--text-primary)">Syllable shape</b></div>
          ${_renderSyllableShapes(stats)}
        </div>
        <div>
          <div class="hint" style="margin-bottom:6px"><b style="color:var(--text-primary)">Word length</b>
            <span style="color:var(--text-muted)"> · phonemes per lemma</span>
          </div>
          ${_renderLengthHistogram(stats)}
        </div>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:14px">
          ${_renderDonut(stats.posBreakdown, 'Parts of speech', posPalette)}
          ${_renderDonut(stats.registerBreakdown, 'Register', regPalette)}
        </div>
      </div>
    </div>`;
}

// Initial paint.
renderAll();
