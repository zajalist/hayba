/* ── Architecture Culture Studio — v1 shell ─────────────── */
/* Self-contained ES module. No globals exported. */

const api = {
  list: () => fetch('/api/cultures').then(r => r.json()),
  get: (id) => fetch(`/api/cultures/${encodeURIComponent(id)}`).then(r => {
    if (!r.ok) throw new Error(r.statusText);
    return r.json();
  }),
  create: (body) => fetch('/api/cultures', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }),
  patch: (id, body) => fetch(`/api/cultures/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => r.json()),
  remove: (id) => fetch(`/api/cultures/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

const state = {
  cultures: [],
  selectedId: null,
  culture: null,
  subtab: 'materials',
  expandedEraId: null,
};

function renderList() {
  const ul = document.getElementById('culture-list');
  if (!ul) return;
  ul.innerHTML = '';
  for (const c of state.cultures) {
    const li = document.createElement('li');
    li.textContent = c.name;
    li.dataset.id = c.id;
    li.className = c.id === state.selectedId ? 'selected' : '';
    li.addEventListener('click', () => select(c.id));
    ul.appendChild(li);
  }
}

function renderHeader() {
  const c = state.culture;
  const nameEl = document.getElementById('culture-name');
  const regionEl = document.getElementById('culture-region');
  const climateEl = document.getElementById('culture-climate');
  const countsEl = document.getElementById('culture-counts');
  const deleteBtn = document.getElementById('culture-delete');

  if (nameEl) nameEl.textContent = c?.name ?? '—';
  if (regionEl) regionEl.textContent = c?.region ?? '—';
  if (climateEl) climateEl.textContent = c?.climate ?? '—';
  if (countsEl) {
    countsEl.textContent = c
      ? `${(c.eras ?? []).length} eras · ${(c.materials ?? []).length} materials · ${(c.ornaments ?? []).length} ornaments`
      : '0 eras';
  }
  if (deleteBtn) deleteBtn.disabled = !c;
}

async function select(id) {
  state.selectedId = id;
  try {
    state.culture = await api.get(id);
  } catch (e) {
    console.error('Failed to load culture', id, e);
    state.culture = null;
  }
  renderList();
  renderHeader();
  // future tasks: renderSubtab(), renderTimeline(), renderEraDetail()
}

async function refreshList() {
  try {
    const raw = await api.list();
    state.cultures = raw.slice().sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    console.error('Failed to load culture list', e);
    state.cultures = [];
  }
  renderList();
  if (state.selectedId && !state.cultures.some(c => c.id === state.selectedId)) {
    state.selectedId = null;
    state.culture = null;
    renderHeader();
  }
  if (!state.selectedId && state.cultures[0]) await select(state.cultures[0].id);
}

/* ── Wire up: Create ─────────────────────────────────────── */

const createBtn = document.getElementById('culture-create');
if (createBtn) {
  createBtn.addEventListener('click', async () => {
    const id = (prompt('Culture id (kebab-case)?') ?? '').trim();
    if (!id) return;
    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
      alert('Id must be kebab-case (lowercase letters, digits, dashes; start with a letter).');
      return;
    }
    const name = (prompt('Display name?') ?? id).trim() || id;
    try {
      await api.create({ id, name, region: '', climate: '' });
    } catch (e) {
      alert(`Create failed: ${e.message}`);
      return;
    }
    await refreshList();
    await select(id);
  });
}

/* ── Wire up: Delete ─────────────────────────────────────── */

const deleteBtn = document.getElementById('culture-delete');
if (deleteBtn) {
  deleteBtn.addEventListener('click', async () => {
    if (!state.selectedId) return;
    if (!confirm(`Delete culture "${state.selectedId}"? This removes its on-disk files.`)) return;
    await api.remove(state.selectedId);
    state.selectedId = null;
    state.culture = null;
    await refreshList();
  });
}

/* ── Wire up: Sub-tabs ───────────────────────────────────── */

document.querySelectorAll('#studio-subtabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    state.subtab = btn.dataset.subtab;
    document.querySelectorAll('#studio-subtabs button').forEach(b => {
      b.classList.toggle('active', b === btn);
    });
    // Task 11 will populate #subtab-body based on state.subtab
  });
});

/* ── Boot ────────────────────────────────────────────────── */

refreshList();
