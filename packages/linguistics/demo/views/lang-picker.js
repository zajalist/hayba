// views/lang-picker.js — topbar dropdown for the user's languages.
// Supports New / Rename / Share / Delete. Read-only mode hides write actions.

import { supabase } from '../auth.js';
import { queueLanguageSave } from '../sync.js';

export function renderLangPicker(state, opts = {}) {
  const host = document.getElementById('lang-picker');
  if (!host) return;
  const { renderAll, saveState, snapshotActiveLanguage, loadLanguageSnapshot } = opts;

  const ids = Object.keys(state.languages ?? {});
  const readonly = state._readonly;

  host.innerHTML = `
    <select id="lp-current">
      ${ids.map(id => `
        <option value="${escapeAttr(id)}" ${id === state.langId ? 'selected' : ''}>
          ${escapeText(id)}${state.languages[id]?._meta?.local_dirty ? ' *' : ''}
        </option>`).join('')}
    </select>
    ${readonly
      ? `<a class="btn" href="/login?next=${encodeURIComponent('/app?fork=' + state.langId)}">Sign in to fork</a>`
      : `
        <button class="btn" id="lp-new">+ New</button>
        <button class="btn" id="lp-rename">Rename</button>
        <button class="btn" id="lp-share">Share</button>
        <button class="btn danger" id="lp-delete">Delete</button>`}
  `;

  document.getElementById('lp-current').onchange = e => {
    if (e.target.value === state.langId) return;
    snapshotActiveLanguage();
    loadLanguageSnapshot(e.target.value);
    saveState(); renderAll();
  };

  if (readonly) return;

  document.getElementById('lp-new').onclick = () => {
    const id = prompt('New language id (slug, lowercase, dashes):');
    if (!id || state.languages?.[id]) return;
    snapshotActiveLanguage();
    state.languages[id] = {};
    state.langId = id;
    loadLanguageSnapshot(id);
    saveState(); renderAll();
    queueLanguageSave(state, id);
  };
  document.getElementById('lp-rename').onclick = () => {
    const fresh = prompt('Rename to:', state.langId);
    if (!fresh || fresh === state.langId || state.languages?.[fresh]) return;
    state.languages[fresh] = state.languages[state.langId];
    delete state.languages[state.langId];
    state.langId = fresh;
    saveState(); renderAll();
  };
  document.getElementById('lp-share').onclick = () => {
    if (window.__haybaOpenShare) window.__haybaOpenShare(state);
  };
  document.getElementById('lp-delete').onclick = async () => {
    if (!confirm(`Delete "${state.langId}"? This cannot be undone.`)) return;
    try {
      await supabase.from('languages').delete().eq('id', state.langId);
    } catch (e) {
      console.error('[lang-picker] remote delete failed', e);
    }
    delete state.languages[state.langId];
    state.langId = Object.keys(state.languages)[0] ?? 'my-conlang';
    loadLanguageSnapshot(state.langId);
    saveState(); renderAll();
  };
}

function escapeAttr(s) { return String(s).replace(/"/g, '&quot;'); }
function escapeText(s) { return String(s).replace(/[<>&]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;' }[c])); }
