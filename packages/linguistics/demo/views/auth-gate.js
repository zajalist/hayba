// views/auth-gate.js — banner shown when the user has localStorage
// conlangs but no remote ones yet, offering one-click migration.

import { migrateLocalToRemote } from '../sync.js';

export function shouldShowMigrationBanner(state) {
  if (!state._signedIn) return false;
  const local = Object.values(state.languages ?? {}).filter(l => !l._meta);
  return local.length > 0;
}

export function renderAuthGate(state, opts = {}) {
  const host = document.getElementById('auth-gate');
  if (!host) return;
  if (!shouldShowMigrationBanner(state)) {
    host.style.display = 'none';
    return;
  }
  const count = Object.values(state.languages ?? {}).filter(l => !l._meta).length;
  host.style.display = 'block';
  host.innerHTML = `
    <div class="auth-banner">
      <div>You have <b>${count}</b> conlang${count === 1 ? '' : 's'} saved in this browser.
        Upload them to your account so they sync across devices.</div>
      <div class="auth-banner-actions">
        <button class="btn primary" id="auth-migrate">Migrate</button>
        <button class="btn" id="auth-dismiss">Not now</button>
      </div>
    </div>`;
  document.getElementById('auth-migrate').onclick = async () => {
    await migrateLocalToRemote(state);
    renderAuthGate(state, opts);
    if (typeof opts.renderAll === 'function') opts.renderAll();
  };
  document.getElementById('auth-dismiss').onclick = () => {
    host.style.display = 'none';
  };
}
