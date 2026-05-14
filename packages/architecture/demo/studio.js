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

/* ── Helpers ─────────────────────────────────────────────── */

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function patchCulture(partial) {
  if (!state.culture) return;
  try {
    const updated = await api.patch(state.culture.id, partial);
    state.culture = updated;
    renderHeader();
  } catch (e) {
    console.error('PATCH culture failed', e);
  }
}

const savePartial = debounce(patchCulture, 300);

function nextId(prefix, items) {
  const nums = items
    .map(item => {
      const m = item.id?.match(new RegExp(`^${prefix}-(\\d+)$`));
      return m ? parseInt(m[1], 10) : -1;
    })
    .filter(n => n >= 0);
  return `${prefix}-${nums.length > 0 ? Math.max(...nums) + 1 : 1}`;
}

/* ── renderList ──────────────────────────────────────────── */

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

/* ── renderHeader (editable) ─────────────────────────────── */

function renderHeader() {
  const c = state.culture;
  const header = document.getElementById('culture-header');
  if (!header) return;

  const fields = header.querySelector('.studio-header-fields');
  if (!fields) return;

  // Build editable header
  fields.innerHTML = `
    <div class="header-edit-row">
      <input id="hdr-name" class="hdr-input hdr-name" type="text" placeholder="Name" value="${esc(c?.name ?? '')}">
    </div>
    <div class="header-edit-row header-meta-row">
      <input id="hdr-region"  class="hdr-input hdr-meta" type="text" placeholder="Region"  value="${esc(c?.region ?? '')}">
      <input id="hdr-climate" class="hdr-input hdr-meta" type="text" placeholder="Climate" value="${esc(c?.climate ?? '')}">
      <span id="culture-counts" class="hdr-counts">${countsText(c)}</span>
    </div>
  `;

  const deleteBtn = document.getElementById('culture-delete');
  if (deleteBtn) deleteBtn.disabled = !c;

  if (!c) return;

  const nameInput    = document.getElementById('hdr-name');
  const regionInput  = document.getElementById('hdr-region');
  const climateInput = document.getElementById('hdr-climate');

  function saveField(field, input) {
    input.addEventListener('input', () => {
      state.culture[field] = input.value;
      savePartial({ [field]: input.value });
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') input.blur();
    });
  }

  saveField('name', nameInput);
  saveField('region', regionInput);
  saveField('climate', climateInput);
}

function countsText(c) {
  if (!c) return '0 eras';
  return `${(c.eras ?? []).length} eras · ${(c.materials ?? []).length} materials · ${(c.ornaments ?? []).length} ornaments`;
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}

/* ── renderSubtab (dispatcher) ───────────────────────────── */

function renderSubtab() {
  const body = document.getElementById('subtab-body');
  if (!body) return;
  if (!state.culture) {
    body.innerHTML = '<p class="placeholder">Select a culture to begin.</p>';
    return;
  }
  switch (state.subtab) {
    case 'materials':     renderMaterialsSubtab(body);    break;
    case 'ornaments':     renderOrnamentsSubtab(body);    break;
    case 'tag-axes':      renderTagAxesSubtab(body);      break;
    case 'culture-rules': renderCultureRulesSubtab(body); break;
    default:
      body.innerHTML = '<p class="placeholder">Unknown sub-tab.</p>';
  }
}

/* ── Materials sub-tab ───────────────────────────────────── */

function renderMaterialsSubtab(body) {
  const materials = state.culture.materials ?? [];

  const wrap = document.createElement('div');
  wrap.className = 'subtab-section';

  const grid = document.createElement('div');
  grid.className = 'mat-grid';

  function buildCard(mat, idx) {
    const card = document.createElement('div');
    card.className = 'mat-card';
    card.innerHTML = `
      <div class="mat-card-top">
        <input type="color" class="mat-color" value="${esc(mat.color ?? '#888888')}" title="Color swatch">
        <div class="mat-card-fields">
          <input type="text" class="mat-name field-input" placeholder="Name" value="${esc(mat.name ?? '')}">
          <span class="mat-id mono muted">${esc(mat.id)}</span>
        </div>
        <button class="mat-remove icon-btn" title="Remove material">×</button>
      </div>
      <div class="mat-card-body">
        <label class="field-label">Grain</label>
        <input type="text" class="mat-grain field-input" placeholder="e.g. fine crystalline" value="${esc(mat.grain ?? '')}">
        <div class="mat-sliders">
          <div class="slider-row">
            <label>Durability</label>
            <input type="range" min="0" max="1" step="0.01" value="${mat.properties?.durability ?? 0.5}">
            <span class="slider-val">${fmt(mat.properties?.durability)}</span>
          </div>
          <div class="slider-row">
            <label>Cost</label>
            <input type="range" min="0" max="1" step="0.01" value="${mat.properties?.cost ?? 0.5}">
            <span class="slider-val">${fmt(mat.properties?.cost)}</span>
          </div>
          <div class="slider-row">
            <label>Workability</label>
            <input type="range" min="0" max="1" step="0.01" value="${mat.properties?.workability ?? 0.5}">
            <span class="slider-val">${fmt(mat.properties?.workability)}</span>
          </div>
        </div>
      </div>
    `;

    // color
    card.querySelector('.mat-color').addEventListener('input', e => {
      materials[idx].color = e.target.value;
      savePartial({ materials });
    });

    // name
    card.querySelector('.mat-name').addEventListener('input', e => {
      materials[idx].name = e.target.value;
      savePartial({ materials });
    });

    // grain
    card.querySelector('.mat-grain').addEventListener('input', e => {
      materials[idx].grain = e.target.value;
      savePartial({ materials });
    });

    // sliders
    const sliders = card.querySelectorAll('.slider-row');
    const sliderKeys = ['durability', 'cost', 'workability'];
    sliders.forEach((row, si) => {
      const input = row.querySelector('input[type=range]');
      const valEl = row.querySelector('.slider-val');
      input.addEventListener('input', e => {
        const v = parseFloat(e.target.value);
        valEl.textContent = fmt(v);
        if (!materials[idx].properties) materials[idx].properties = {};
        materials[idx].properties[sliderKeys[si]] = v;
        savePartial({ materials });
      });
    });

    // remove
    card.querySelector('.mat-remove').addEventListener('click', () => {
      state.culture.materials = materials.filter((_, i) => i !== idx);
      savePartial({ materials: state.culture.materials });
      renderSubtab();
    });

    return card;
  }

  materials.forEach((mat, idx) => grid.appendChild(buildCard(mat, idx)));

  const addBtn = document.createElement('button');
  addBtn.className = 'add-btn';
  addBtn.textContent = '+ Add material';
  addBtn.addEventListener('click', () => {
    const newMat = {
      // TODO: v2 — derive id from name on rename; for now id is immutable after creation
      id: nextId('new-material', state.culture.materials ?? []),
      name: 'New material',
      color: '#888888',
      grain: '',
      properties: { durability: 0.5, cost: 0.5, workability: 0.5 },
    };
    state.culture.materials = [...(state.culture.materials ?? []), newMat];
    savePartial({ materials: state.culture.materials });
    renderSubtab();
  });

  wrap.appendChild(grid);
  wrap.appendChild(addBtn);
  body.innerHTML = '';
  body.appendChild(wrap);
}

function fmt(v) {
  return v == null ? '—' : Number(v).toFixed(2);
}

/* ── Ornaments sub-tab ───────────────────────────────────── */

function renderOrnamentsSubtab(body) {
  const ornaments = state.culture.ornaments ?? [];

  const wrap = document.createElement('div');
  wrap.className = 'subtab-section';

  function buildRow(orn, idx) {
    const row = document.createElement('div');
    row.className = 'orn-row';

    row.innerHTML = `
      <div class="orn-row-header">
        <input type="text" class="orn-name field-input" placeholder="Ornament name" value="${esc(orn.name ?? '')}">
        <button class="orn-remove icon-btn" title="Remove ornament">× remove</button>
      </div>
      <textarea class="orn-desc field-input" rows="3" placeholder="Description">${esc(orn.description ?? '')}</textarea>
      <div class="orn-paths">
        <label class="field-label">Reference image path</label>
        <input type="text" class="orn-imgpath field-input" placeholder="/path/to/image.png" value="${esc((orn.referenceImagePaths ?? [])[0] ?? '')}">
        <label class="field-label">PBR texture path</label>
        <input type="text" class="orn-pbrpath field-input" placeholder="/path/to/texture.png" value="${esc(orn.pbrTexturePath ?? '')}">
      </div>
      <div class="orn-weights">
        <div class="field-label">Scenario weights</div>
        <div class="weight-list"></div>
        <button class="add-weight-btn add-btn-sm">+ Add weight</button>
      </div>
    `;

    function save() { savePartial({ ornaments: state.culture.ornaments }); }

    row.querySelector('.orn-name').addEventListener('input', e => {
      ornaments[idx].name = e.target.value;
      save();
    });

    row.querySelector('.orn-desc').addEventListener('input', e => {
      ornaments[idx].description = e.target.value;
      save();
    });

    row.querySelector('.orn-imgpath').addEventListener('input', e => {
      if (!ornaments[idx].referenceImagePaths) ornaments[idx].referenceImagePaths = [];
      ornaments[idx].referenceImagePaths[0] = e.target.value;
      save();
    });

    row.querySelector('.orn-pbrpath').addEventListener('input', e => {
      ornaments[idx].pbrTexturePath = e.target.value;
      save();
    });

    row.querySelector('.orn-remove').addEventListener('click', () => {
      state.culture.ornaments = ornaments.filter((_, i) => i !== idx);
      savePartial({ ornaments: state.culture.ornaments });
      renderSubtab();
    });

    // Scenario weights
    const weightList = row.querySelector('.weight-list');
    const weights = orn.scenarioWeights ?? {};

    function renderWeights() {
      weightList.innerHTML = '';
      Object.entries(weights).forEach(([tag, val]) => {
        const wrow = document.createElement('div');
        wrow.className = 'weight-row';
        wrow.innerHTML = `
          <input type="text" class="wt-tag field-input-sm" value="${esc(tag)}" placeholder="tag">
          <input type="range" class="wt-slider" min="0" max="1" step="0.01" value="${val}">
          <span class="wt-val">${fmt(val)}</span>
          <button class="wt-remove icon-btn-sm">×</button>
        `;
        wrow.querySelector('.wt-tag').addEventListener('change', e => {
          const newTag = e.target.value.trim();
          if (!newTag || newTag === tag) return;
          const v = weights[tag];
          delete weights[tag];
          weights[newTag] = v;
          ornaments[idx].scenarioWeights = weights;
          save();
          renderWeights();
        });
        wrow.querySelector('.wt-slider').addEventListener('input', e => {
          const v = parseFloat(e.target.value);
          wrow.querySelector('.wt-val').textContent = fmt(v);
          weights[tag] = v;
          ornaments[idx].scenarioWeights = weights;
          save();
        });
        wrow.querySelector('.wt-remove').addEventListener('click', () => {
          delete weights[tag];
          ornaments[idx].scenarioWeights = weights;
          save();
          renderWeights();
        });
        weightList.appendChild(wrow);
      });
    }

    renderWeights();

    row.querySelector('.add-weight-btn').addEventListener('click', () => {
      let key = 'new-tag';
      let n = 1;
      while (weights[key]) key = `new-tag-${n++}`;
      weights[key] = 0.5;
      ornaments[idx].scenarioWeights = weights;
      save();
      renderWeights();
    });

    return row;
  }

  ornaments.forEach((orn, idx) => wrap.appendChild(buildRow(orn, idx)));

  const addBtn = document.createElement('button');
  addBtn.className = 'add-btn';
  addBtn.textContent = '+ Add ornament';
  addBtn.addEventListener('click', () => {
    const newOrn = {
      id: nextId('new-ornament', state.culture.ornaments ?? []),
      name: 'New ornament',
      description: '',
      referenceImagePaths: [],
      pbrTexturePath: '',
      scenarioWeights: {},
    };
    state.culture.ornaments = [...(state.culture.ornaments ?? []), newOrn];
    savePartial({ ornaments: state.culture.ornaments });
    renderSubtab();
  });

  wrap.appendChild(addBtn);
  body.innerHTML = '';
  body.appendChild(wrap);
}

/* ── Tag axes sub-tab ────────────────────────────────────── */

function renderTagAxesSubtab(body) {
  const tagAxes = state.culture.tagAxes ?? [];

  const wrap = document.createElement('div');
  wrap.className = 'subtab-section';

  function save() { savePartial({ tagAxes: state.culture.tagAxes }); }

  function buildAxisCard(axis, axIdx) {
    const card = document.createElement('div');
    card.className = 'axis-card';

    card.innerHTML = `
      <div class="axis-header">
        <span class="axis-id mono muted">${esc(axis.id)}</span>
        <input type="text" class="axis-label field-input" placeholder="Label" value="${esc(axis.label ?? '')}">
        <button class="axis-remove icon-btn">× remove</button>
      </div>
      <div class="axis-values"></div>
      <button class="add-val-btn add-btn-sm">+ Add value</button>
    `;

    card.querySelector('.axis-label').addEventListener('input', e => {
      tagAxes[axIdx].label = e.target.value;
      save();
    });

    card.querySelector('.axis-remove').addEventListener('click', () => {
      state.culture.tagAxes = tagAxes.filter((_, i) => i !== axIdx);
      savePartial({ tagAxes: state.culture.tagAxes });
      renderSubtab();
    });

    const valList = card.querySelector('.axis-values');

    function renderValues() {
      valList.innerHTML = '';
      (axis.values ?? []).forEach((val, vIdx) => {
        const vrow = document.createElement('div');
        vrow.className = 'axis-val-row';
        vrow.innerHTML = `
          <input type="text" class="val-id field-input-sm" placeholder="value-id" value="${esc(val.id ?? '')}">
          <input type="text" class="val-label field-input-sm" placeholder="Label" value="${esc(val.label ?? '')}">
          <button class="val-remove icon-btn-sm">×</button>
        `;
        vrow.querySelector('.val-id').addEventListener('input', e => {
          tagAxes[axIdx].values[vIdx].id = e.target.value;
          save();
        });
        vrow.querySelector('.val-label').addEventListener('input', e => {
          tagAxes[axIdx].values[vIdx].label = e.target.value;
          save();
        });
        vrow.querySelector('.val-remove').addEventListener('click', () => {
          tagAxes[axIdx].values = axis.values.filter((_, i) => i !== vIdx);
          save();
          renderValues();
        });
        valList.appendChild(vrow);
      });
    }

    renderValues();

    card.querySelector('.add-val-btn').addEventListener('click', () => {
      if (!tagAxes[axIdx].values) tagAxes[axIdx].values = [];
      tagAxes[axIdx].values.push({ id: 'new-value', label: 'New value' });
      save();
      renderValues();
    });

    return card;
  }

  tagAxes.forEach((axis, axIdx) => wrap.appendChild(buildAxisCard(axis, axIdx)));

  const addBtn = document.createElement('button');
  addBtn.className = 'add-btn';
  addBtn.textContent = '+ Add axis';
  addBtn.addEventListener('click', () => {
    const newAxis = {
      id: nextId('new-axis', state.culture.tagAxes ?? []),
      label: 'New axis',
      values: [],
    };
    state.culture.tagAxes = [...(state.culture.tagAxes ?? []), newAxis];
    savePartial({ tagAxes: state.culture.tagAxes });
    renderSubtab();
  });

  wrap.appendChild(addBtn);
  body.innerHTML = '';
  body.appendChild(wrap);
}

/* ── Culture rules sub-tab (placeholder, Task 14 will add full editor) ── */

function renderCultureRulesSubtab(body) {
  const rules = state.culture.rules ?? [];

  const wrap = document.createElement('div');
  wrap.className = 'subtab-section';

  const note = document.createElement('p');
  note.className = 'placeholder rules-note';
  note.textContent = 'Full conditional editor lands in Task 14.';
  wrap.appendChild(note);

  if (rules.length > 0) {
    const table = document.createElement('table');
    table.className = 'rules-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th>id</th><th>priority</th><th>scenario</th><th>tag matches</th><th>assigns</th><th></th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');
    rules.forEach((rule, idx) => {
      const tr = document.createElement('tr');
      const tagSummary = (rule.conditions?.tagMatches ?? []).map(t => `${t.axis}=${t.value}`).join(', ') || '—';
      const assignSummary = Object.entries(rule.assigns ?? {}).map(([k,v]) => `${k}=${v}`).join(', ') || '—';
      tr.innerHTML = `
        <td class="mono">${esc(rule.id ?? '')}</td>
        <td>${rule.priority ?? 0}</td>
        <td>${esc(rule.scenario ?? '—')}</td>
        <td class="muted">${esc(tagSummary)}</td>
        <td class="muted">${esc(assignSummary)}</td>
        <td><button class="rule-del icon-btn-sm">× Delete</button></td>
      `;
      tr.querySelector('.rule-del').addEventListener('click', () => {
        state.culture.rules = rules.filter((_, i) => i !== idx);
        savePartial({ rules: state.culture.rules });
        renderSubtab();
      });
      tbody.appendChild(tr);
    });
    wrap.appendChild(table);
  } else {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.style.fontSize = '12px';
    empty.style.padding = '4px 0';
    empty.textContent = 'No rules yet.';
    wrap.appendChild(empty);
  }

  const addBtn = document.createElement('button');
  addBtn.className = 'add-btn';
  addBtn.textContent = '+ Add rule';
  addBtn.addEventListener('click', () => {
    const newRule = {
      id: nextId('new-rule', state.culture.rules ?? []),
      priority: 0,
      scenario: '',
      conditions: { tagMatches: [] },
      assigns: {},
    };
    state.culture.rules = [...(state.culture.rules ?? []), newRule];
    savePartial({ rules: state.culture.rules });
    renderSubtab();
  });

  wrap.appendChild(addBtn);
  body.innerHTML = '';
  body.appendChild(wrap);
}

/* ── Timeline ────────────────────────────────────────────── */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

function renderTimeline() {
  const el = document.getElementById('culture-timeline');
  if (!el) return;
  el.innerHTML = '';
  if (!state.culture) return;
  const eras = state.culture.eras ?? [];

  if (eras.length === 0) {
    const btn = document.createElement('button');
    btn.className = 'add-btn timeline-empty-add';
    btn.textContent = '+ Add first era';
    btn.addEventListener('click', addEra);
    el.appendChild(btn);
    return;
  }

  const minY = Math.min(...eras.map(e => e.dateRange?.[0] ?? 0)) - 50;
  const maxY = Math.max(...eras.map(e => e.dateRange?.[1] ?? 0)) + 50;
  const span = Math.max(maxY - minY, 1);

  const track = document.createElement('div');
  track.className = 'timeline-track';
  for (const era of eras) {
    const dr = era.dateRange ?? [0, 100];
    const left = ((dr[0] - minY) / span) * 100;
    const width = Math.max(((dr[1] - dr[0]) / span) * 100, 1);
    const block = document.createElement('button');
    block.className = 'era-block' + (era.id === state.expandedEraId ? ' expanded' : '');
    block.style.left = left + '%';
    block.style.width = width + '%';
    block.innerHTML = `<span class="era-name">${escapeHtml(era.name)}</span><span class="era-dates">${dr[0]}–${dr[1]}</span>`;
    block.title = `${era.name} (${dr[0]}–${dr[1]})`;
    block.addEventListener('click', () => expandEra(era.id));
    track.appendChild(block);
  }
  el.appendChild(track);

  const axis = document.createElement('div');
  axis.className = 'timeline-axis';
  const ticks = [minY, Math.round((minY + maxY) / 2), maxY];
  for (const t of ticks) {
    const tick = document.createElement('span');
    tick.textContent = t;
    axis.appendChild(tick);
  }
  el.appendChild(axis);

  const addBtn = document.createElement('button');
  addBtn.className = 'add-btn timeline-add';
  addBtn.textContent = '+ Add era';
  addBtn.addEventListener('click', addEra);
  el.appendChild(addBtn);
}

async function addEra() {
  const id = (prompt('Era id (kebab-case)?') ?? '').trim();
  if (!id) return;
  if (!/^[a-z][a-z0-9-]*$/.test(id)) { alert('Id must be kebab-case.'); return; }
  if ((state.culture.eras ?? []).some(e => e.id === id)) { alert('An era with that id already exists.'); return; }
  const name = (prompt('Era name?') ?? id).trim() || id;
  const start = Number(prompt('Start year?') ?? '0');
  const end = Number(prompt('End year?') ?? '100');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) { alert('Invalid date range — end must be greater than start.'); return; }
  if (!state.culture.eras) state.culture.eras = [];
  state.culture.eras.push({
    id, name, dateRange: [start, end],
    defaults: {
      roofType: 'gabled',
      proportions: { columnSlenderness: 1, storyHeight: 1, doorAspect: 1 },
      palette: [],
      ornamentDensity: 'moderate',
      technique: '',
    },
    typologyMix: {},
    rules: [],
  });
  await patchCulture({ eras: state.culture.eras });
  state.expandedEraId = id;
  renderTimeline();
  renderEraDetail();
}

function expandEra(eraId) {
  state.expandedEraId = state.expandedEraId === eraId ? null : eraId;
  renderTimeline();
  renderEraDetail();
}

/* ── Era detail shell ────────────────────────────────────── */
// v2: drag-to-resize and drag-to-move era blocks on the timeline track are deferred.
// Only click-to-expand and form-based editing of dateRange are implemented here.

function renderEraDetail() {
  const el = document.getElementById('era-detail');
  if (!el) return;
  if (!state.expandedEraId || !state.culture) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  const era = (state.culture.eras ?? []).find(e => e.id === state.expandedEraId);
  if (!era) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `
    <header class="era-detail-header">
      <input class="era-name-input" value="${escapeAttr(era.name)}" data-field="name" />
      <div class="era-date-inputs">
        <input type="number" data-field="start" value="${era.dateRange?.[0] ?? 0}" />
        <span>–</span>
        <input type="number" data-field="end" value="${era.dateRange?.[1] ?? 100}" />
      </div>
      <button class="era-detail-collapse" title="Collapse">▾ Collapse</button>
      <button class="era-detail-delete" title="Delete era">× Delete era</button>
    </header>
    <div class="era-detail-grid">
      <section id="panel-defaults"><h3>Defaults</h3><div class="panel-body"><p class="placeholder">Defaults editor lands in Task 13.</p></div></section>
      <section id="panel-typology"><h3>Typology mix</h3><div class="panel-body"><p class="placeholder">Typology mix editor lands in Task 13.</p></div></section>
      <section id="panel-rules"><h3>Rules</h3><div class="panel-body"><p class="placeholder">Rule editor lands in Task 14.</p></div></section>
      <section id="panel-ornaments"><h3>Ornaments</h3><div class="panel-body"><p class="placeholder">Ornament link lands in Task 13.</p></div></section>
    </div>
  `;
  el.querySelector('.era-name-input').addEventListener('input', (e) => {
    era.name = e.target.value;
    savePartial({ eras: state.culture.eras });
  });
  for (const inp of el.querySelectorAll('input[type="number"]')) {
    inp.addEventListener('input', () => {
      const start = Number(el.querySelector('[data-field="start"]').value);
      const end = Number(el.querySelector('[data-field="end"]').value);
      era.dateRange = [start, end];
      savePartial({ eras: state.culture.eras });
      renderTimeline();
    });
  }
  el.querySelector('.era-detail-collapse').addEventListener('click', () => {
    state.expandedEraId = null;
    renderTimeline();
    renderEraDetail();
  });
  el.querySelector('.era-detail-delete').addEventListener('click', async () => {
    if (!confirm(`Delete era "${era.id}"?`)) return;
    state.culture.eras = (state.culture.eras ?? []).filter(e => e.id !== era.id);
    state.expandedEraId = null;
    await patchCulture({ eras: state.culture.eras });
    renderTimeline();
    renderEraDetail();
  });
}

/* ── select & refresh ────────────────────────────────────── */

async function select(id) {
  state.selectedId = id;
  state.expandedEraId = null;
  try {
    state.culture = await api.get(id);
  } catch (e) {
    console.error('Failed to load culture', id, e);
    state.culture = null;
  }
  renderList();
  renderHeader();
  renderSubtab();
  renderTimeline();
  renderEraDetail();
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
    renderSubtab();
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
    renderSubtab();
  });
});

/* ── Boot ────────────────────────────────────────────────── */

refreshList();
