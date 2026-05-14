// views/share.js — modal toggling languages.is_public + copy URL.

import { supabase } from '../auth.js';

window.__haybaOpenShare = openShareDialog;

function openShareDialog(state) {
  const lang = state.languages?.[state.langId];
  if (!lang) return;
  const isPublic = !!lang._meta?.is_public;
  const url = `${window.location.origin}/lang/${state.langId}`;
  const dlg = document.createElement('div');
  dlg.className = 'modal-backdrop';
  dlg.innerHTML = `
    <div class="modal">
      <h3>Share "${escapeText(state.langId)}"</h3>
      <p class="muted">When public, anyone with this link can view (but not edit).</p>
      <label class="checkbox">
        <input type="checkbox" id="share-public" ${isPublic ? 'checked' : ''}>
        Public read-only
      </label>
      <div id="share-url-row" style="display:${isPublic ? 'flex' : 'none'}">
        <input class="input mono" readonly value="${escapeAttr(url)}" id="share-url">
        <button class="btn" id="share-copy">Copy</button>
      </div>
      <div class="modal-actions">
        <button class="btn" id="share-close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);

  document.getElementById('share-public').onchange = async e => {
    const next = e.target.checked;
    const { error } = await supabase.from('languages')
      .update({ is_public: next })
      .eq('id', state.langId);
    if (error) { alert('Failed: ' + error.message); e.target.checked = !next; return; }
    lang._meta = { ...(lang._meta ?? {}), is_public: next };
    document.getElementById('share-url-row').style.display = next ? 'flex' : 'none';
  };
  document.getElementById('share-copy').onclick = () => {
    navigator.clipboard.writeText(url);
    const btn = document.getElementById('share-copy');
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = orig, 1200);
  };
  document.getElementById('share-close').onclick = () => dlg.remove();
}

function escapeAttr(s) { return String(s).replace(/"/g, '&quot;'); }
function escapeText(s) { return String(s).replace(/[<>&]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;' }[c])); }
