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

/* ── Culture rules sub-tab ───────────────────────────────── */

function renderCultureRulesSubtab(body) {
  const wrap = document.createElement('div');
  wrap.className = 'subtab-section';
  renderRuleEditor('culture', wrap);
  body.innerHTML = '';
  body.appendChild(wrap);
}

/* ── Rule editor (shared by culture sub-tab + era panel) ─── */
/**
 * scope: 'culture'  → edits state.culture.rules
 *        {eraId: string} → edits the named era's rules
 *
 * v2: drag-to-reorder via HTML5 drag-and-drop. For now, priority is a
 * numeric input so the user can set sort order directly.
 */
function renderRuleEditor(scope, container) {
  const isEraScope = typeof scope === 'object' && scope !== null;
  const eraId = isEraScope ? scope.eraId : null;
  const era = isEraScope
    ? (state.culture.eras ?? []).find(e => e.id === eraId) ?? null
    : null;

  // Helpers to get/set the active rule list
  function getRules() {
    if (isEraScope) return era ? (era.rules ?? []) : [];
    return state.culture.rules ?? [];
  }
  function setRules(arr) {
    if (isEraScope) {
      if (era) era.rules = arr;
      savePartial({ eras: state.culture.eras });
    } else {
      state.culture.rules = arr;
      savePartial({ rules: state.culture.rules });
    }
  }

  const list = document.createElement('div');
  list.className = 'rule-list';

  function rerenderList() {
    list.innerHTML = '';
    // Era scope: show inherited culture rules first (grayed), unless overridden
    if (isEraScope) {
      const eraRuleIds = new Set(getRules().map(r => r.id));
      const inheritedRules = (state.culture.rules ?? []).filter(r => !eraRuleIds.has(r.id));
      for (const rule of inheritedRules) {
        list.appendChild(buildRuleRow(rule, true));
      }
    }
    // Own rules
    for (const rule of getRules()) {
      list.appendChild(buildRuleRow(rule, false));
    }
    if (getRules().length === 0 && !(isEraScope && (state.culture.rules ?? []).length > 0)) {
      const ph = document.createElement('p');
      ph.className = 'placeholder';
      ph.style.margin = '4px 0';
      ph.textContent = 'No rules yet.';
      list.appendChild(ph);
    }
    // Re-render grid after list update
    renderRuleGrid(scope, gridContainer);
  }

  function buildRuleRow(rule, inherited) {
    const row = document.createElement('div');
    row.className = 'rule-row' + (inherited ? ' rule-row-inherited' : '');

    // ─ priority ─
    const priLabel = document.createElement('label');
    priLabel.className = 'rule-field-label';
    priLabel.textContent = 'Priority';
    const priInput = document.createElement('input');
    priInput.type = 'number';
    priInput.className = 'rule-priority field-input-sm';
    priInput.value = rule.priority ?? 0;
    priInput.disabled = inherited;
    priInput.style.width = '52px';
    priInput.addEventListener('input', () => {
      rule.priority = parseInt(priInput.value, 10) || 0;
      setRules(getRules());
    });

    // ─ id ─
    const idSpan = document.createElement('span');
    idSpan.className = 'rule-id mono muted';
    idSpan.textContent = rule.id;
    idSpan.title = rule.id;

    // ─ scenario ─
    const scenLabel = document.createElement('label');
    scenLabel.className = 'rule-field-label';
    scenLabel.textContent = 'Scenario';
    const scenInput = document.createElement('input');
    scenInput.type = 'text';
    scenInput.className = 'field-input-sm rule-scenario';
    scenInput.placeholder = '* (any)';
    scenInput.value = rule.conditions?.scenario ?? '';
    scenInput.disabled = inherited;
    scenInput.addEventListener('input', () => {
      if (!rule.conditions) rule.conditions = { tagMatches: {} };
      const v = scenInput.value.trim();
      rule.conditions.scenario = v || undefined;
      setRules(getRules());
      renderRuleGrid(scope, gridContainer);
    });

    // ─ tagMatches chip area ─
    const tagLabel = document.createElement('div');
    tagLabel.className = 'rule-field-label';
    tagLabel.textContent = 'Tag matches';
    const tagArea = document.createElement('div');
    tagArea.className = 'rule-chip-area';

    function renderTagChips() {
      tagArea.innerHTML = '';
      const tagMatches = rule.conditions?.tagMatches ?? {};
      for (const [axis, val] of Object.entries(tagMatches)) {
        const chip = document.createElement('span');
        chip.className = 'rule-chip removable';
        chip.textContent = `${axis}: ${val}`;
        if (!inherited) {
          const x = document.createElement('button');
          x.className = 'chip-remove';
          x.textContent = '×';
          x.title = `Remove ${axis}`;
          x.addEventListener('click', () => {
            delete rule.conditions.tagMatches[axis];
            setRules(getRules());
            renderTagChips();
            renderRuleGrid(scope, gridContainer);
          });
          chip.appendChild(x);
        }
        tagArea.appendChild(chip);
      }
      if (!inherited) {
        const addTagBtn = document.createElement('button');
        addTagBtn.className = 'add-btn-sm rule-add-tag-btn';
        addTagBtn.textContent = '+ Tag';
        addTagBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openTagPopover(addTagBtn, rule, () => {
            setRules(getRules());
            renderTagChips();
            renderRuleGrid(scope, gridContainer);
          });
        });
        tagArea.appendChild(addTagBtn);
      }
    }
    renderTagChips();

    // ─ materialId select ─
    const matLabel = document.createElement('label');
    matLabel.className = 'rule-field-label';
    matLabel.textContent = 'Material';
    const matSelect = document.createElement('select');
    matSelect.className = 'field-input-sm rule-material-select';
    matSelect.disabled = inherited;
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = '— none —';
    matSelect.appendChild(emptyOpt);
    for (const mat of state.culture.materials ?? []) {
      const opt = document.createElement('option');
      opt.value = mat.id;
      opt.textContent = mat.name ? `${mat.name} (${mat.id})` : mat.id;
      opt.selected = rule.assigns?.materialId === mat.id;
      matSelect.appendChild(opt);
    }
    if (rule.assigns?.materialId && !(state.culture.materials ?? []).some(m => m.id === rule.assigns.materialId)) {
      const opt = document.createElement('option');
      opt.value = rule.assigns.materialId;
      opt.textContent = rule.assigns.materialId;
      opt.selected = true;
      matSelect.appendChild(opt);
    }
    matSelect.addEventListener('change', () => {
      if (!rule.assigns) rule.assigns = {};
      rule.assigns.materialId = matSelect.value || undefined;
      setRules(getRules());
      renderRuleGrid(scope, gridContainer);
    });

    // ─ ornamentIds chip area ─
    const ornLabel = document.createElement('div');
    ornLabel.className = 'rule-field-label';
    ornLabel.textContent = 'Ornaments';
    const ornArea = document.createElement('div');
    ornArea.className = 'rule-chip-area';

    function renderOrnChips() {
      ornArea.innerHTML = '';
      const ids = rule.assigns?.ornamentIds ?? [];
      for (const oid of ids) {
        const chip = document.createElement('span');
        chip.className = 'rule-chip removable';
        chip.textContent = oid;
        if (!inherited) {
          const x = document.createElement('button');
          x.className = 'chip-remove';
          x.textContent = '×';
          x.addEventListener('click', () => {
            rule.assigns.ornamentIds = ids.filter(o => o !== oid);
            setRules(getRules());
            renderOrnChips();
          });
          chip.appendChild(x);
        }
        ornArea.appendChild(chip);
      }
      if (!inherited) {
        const addOrnBtn = document.createElement('button');
        addOrnBtn.className = 'add-btn-sm';
        addOrnBtn.textContent = '+ Ornament';
        addOrnBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openOrnamentPopover(addOrnBtn, rule, () => {
            setRules(getRules());
            renderOrnChips();
          });
        });
        ornArea.appendChild(addOrnBtn);
      }
    }
    renderOrnChips();

    // ─ weight slider ─
    const weightLabel = document.createElement('label');
    weightLabel.className = 'rule-field-label';
    weightLabel.textContent = 'Weight';
    const weightWrap = document.createElement('div');
    weightWrap.className = 'rule-weight-wrap';
    const weightSlider = document.createElement('input');
    weightSlider.type = 'range';
    weightSlider.min = '0';
    weightSlider.max = '1';
    weightSlider.step = '0.01';
    weightSlider.value = rule.assigns?.weight ?? 1;
    weightSlider.disabled = inherited;
    const weightVal = document.createElement('span');
    weightVal.className = 'slider-val';
    weightVal.textContent = fmt(rule.assigns?.weight ?? 1);
    weightSlider.addEventListener('input', () => {
      if (!rule.assigns) rule.assigns = {};
      rule.assigns.weight = parseFloat(weightSlider.value);
      weightVal.textContent = fmt(rule.assigns.weight);
      setRules(getRules());
    });
    weightWrap.appendChild(weightSlider);
    weightWrap.appendChild(weightVal);

    // ─ delete / override button ─
    const actionBtn = document.createElement('button');
    if (inherited) {
      actionBtn.className = 'add-btn-sm rule-override-btn';
      actionBtn.textContent = 'Override in era';
      actionBtn.addEventListener('click', () => {
        const clone = JSON.parse(JSON.stringify(rule));
        era.rules = [...(era.rules ?? []), clone];
        savePartial({ eras: state.culture.eras });
        rerenderList();
      });
    } else {
      actionBtn.className = 'icon-btn rule-delete-btn';
      actionBtn.textContent = '× Delete';
      actionBtn.addEventListener('click', () => {
        setRules(getRules().filter(r => r.id !== rule.id));
        rerenderList();
      });
    }

    // ─ assemble row ─
    const meta = document.createElement('div');
    meta.className = 'rule-row-meta';
    meta.appendChild(idSpan);

    const fields = document.createElement('div');
    fields.className = 'rule-row-fields';

    function fieldGroup(label, input) {
      const g = document.createElement('div');
      g.className = 'rule-field-group';
      g.appendChild(label);
      g.appendChild(input);
      return g;
    }

    fields.appendChild(fieldGroup(priLabel, priInput));
    fields.appendChild(fieldGroup(scenLabel, scenInput));

    const tagGroup = document.createElement('div');
    tagGroup.className = 'rule-field-group rule-field-group-wide';
    tagGroup.appendChild(tagLabel);
    tagGroup.appendChild(tagArea);
    fields.appendChild(tagGroup);

    fields.appendChild(fieldGroup(matLabel, matSelect));

    const ornGroup = document.createElement('div');
    ornGroup.className = 'rule-field-group rule-field-group-wide';
    ornGroup.appendChild(ornLabel);
    ornGroup.appendChild(ornArea);
    fields.appendChild(ornGroup);

    const weightGroup = document.createElement('div');
    weightGroup.className = 'rule-field-group';
    weightGroup.appendChild(weightLabel);
    weightGroup.appendChild(weightWrap);
    fields.appendChild(weightGroup);

    row.appendChild(meta);
    row.appendChild(fields);
    row.appendChild(actionBtn);

    return row;
  }

  rerenderList();

  // ─ Add rule button ─
  const addRuleBtn = document.createElement('button');
  addRuleBtn.className = 'add-btn';
  addRuleBtn.textContent = '+ Add rule';
  addRuleBtn.addEventListener('click', () => {
    const newRule = {
      id: nextId('new-rule', [...(state.culture.rules ?? []), ...(era?.rules ?? [])]),
      priority: 0,
      conditions: { tagMatches: {} },
      assigns: {},
    };
    setRules([...getRules(), newRule]);
    rerenderList();
  });

  // ─ Grid preview ─
  const gridContainer = document.createElement('div');
  gridContainer.className = 'rule-grid-container';
  renderRuleGrid(scope, gridContainer);

  container.appendChild(list);
  container.appendChild(addRuleBtn);
  container.appendChild(gridContainer);
}

/* ── Tag popover ──────────────────────────────────────────── */

function openTagPopover(anchor, rule, onCommit) {
  closeAllPopovers();
  const tagAxes = state.culture.tagAxes ?? [];
  if (tagAxes.length === 0) {
    alert('No tag axes defined yet. Add tag axes in the "Tag axes" sub-tab first.');
    return;
  }
  const pop = document.createElement('div');
  pop.className = 'rule-popover';
  pop.innerHTML = `
    <div class="rule-popover-title">Add tag match</div>
    <div class="rule-popover-body">
      <select class="rule-popover-axis field-input-sm">
        ${tagAxes.map(a => `<option value="${esc(a.id)}">${esc(a.label || a.id)}</option>`).join('')}
      </select>
      <select class="rule-popover-value field-input-sm">
        <option value="">— pick axis first —</option>
      </select>
      <button class="add-btn-sm rule-popover-confirm">Add</button>
    </div>
  `;
  const axisSelect = pop.querySelector('.rule-popover-axis');
  const valueSelect = pop.querySelector('.rule-popover-value');

  function updateValues() {
    const axis = tagAxes.find(a => a.id === axisSelect.value);
    valueSelect.innerHTML = (axis?.values ?? []).map(v => `<option value="${esc(v.id)}">${esc(v.label || v.id)}</option>`).join('') ||
      '<option value="">— no values defined —</option>';
  }
  axisSelect.addEventListener('change', updateValues);
  updateValues();

  pop.querySelector('.rule-popover-confirm').addEventListener('click', () => {
    const axis = axisSelect.value;
    const val  = valueSelect.value;
    if (!axis || !val) return;
    if (!rule.conditions) rule.conditions = { tagMatches: {} };
    rule.conditions.tagMatches[axis] = val;
    onCommit();
    pop.remove();
  });

  anchor.parentElement.style.position = 'relative';
  anchor.parentElement.appendChild(pop);
  document.addEventListener('click', (e) => {
    if (!pop.contains(e.target) && e.target !== anchor) pop.remove();
  }, { once: true, capture: true });
}

function openOrnamentPopover(anchor, rule, onCommit) {
  closeAllPopovers();
  const ornaments = state.culture.ornaments ?? [];
  if (ornaments.length === 0) {
    alert('No ornaments in the library yet. Add ornaments first.');
    return;
  }
  const existing = new Set(rule.assigns?.ornamentIds ?? []);
  const pop = document.createElement('div');
  pop.className = 'rule-popover';
  pop.innerHTML = `
    <div class="rule-popover-title">Add ornament</div>
    <div class="rule-popover-body rule-popover-orn-list">
      ${ornaments.map(o => `
        <button class="rule-popover-orn-item add-btn-sm${existing.has(o.id) ? ' disabled' : ''}" data-id="${esc(o.id)}" ${existing.has(o.id) ? 'disabled' : ''}>
          ${esc(o.name || o.id)}
        </button>
      `).join('')}
    </div>
  `;
  pop.querySelectorAll('.rule-popover-orn-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      if (!id) return;
      if (!rule.assigns) rule.assigns = {};
      if (!rule.assigns.ornamentIds) rule.assigns.ornamentIds = [];
      if (!rule.assigns.ornamentIds.includes(id)) rule.assigns.ornamentIds.push(id);
      onCommit();
      pop.remove();
    });
  });
  anchor.parentElement.style.position = 'relative';
  anchor.parentElement.appendChild(pop);
  document.addEventListener('click', (e) => {
    if (!pop.contains(e.target) && e.target !== anchor) pop.remove();
  }, { once: true, capture: true });
}

function closeAllPopovers() {
  document.querySelectorAll('.rule-popover').forEach(p => p.remove());
}

/* ── Resolved grid preview ───────────────────────────────── */

function renderRuleGrid(scope, container) {
  if (!container) return;
  container.innerHTML = '';

  // Culture scope: grid requires era context
  if (scope === 'culture') {
    const note = document.createElement('p');
    note.className = 'placeholder';
    note.textContent = 'Grid preview shows in an era context. Open an era to see this culture\'s rules resolved.';
    container.appendChild(note);
    return;
  }

  const eraId = scope.eraId;
  const culture = state.culture;
  if (!culture) return;

  // Collect all scenarios used across culture + era rules
  const era = (culture.eras ?? []).find(e => e.id === eraId);
  if (!era) return;

  const allRules = [...(culture.rules ?? []), ...(era.rules ?? [])];
  const scenarioSet = new Set(allRules.map(r => r.conditions?.scenario).filter(Boolean));
  const scenarios = scenarioSet.size > 0 ? [...scenarioSet] : ['*'];

  // Build cartesian product of tag axes, capped at 32 columns
  const tagAxes = culture.tagAxes ?? [];
  let columns = [{}]; // start with one empty combo
  for (const axis of tagAxes) {
    const vals = (axis.values ?? []).map(v => v.id).filter(Boolean);
    if (vals.length === 0) continue;
    const expanded = [];
    for (const combo of columns) {
      for (const v of vals) {
        expanded.push({ ...combo, [axis.id]: v });
      }
    }
    columns = expanded;
    if (columns.length > 32) break;
  }
  const CAP = 32;
  const truncated = columns.length > CAP;
  if (truncated) columns = columns.slice(0, CAP);

  if (columns.length === 0) columns = [{}];

  // Build header labels
  function colLabel(combo) {
    const entries = Object.entries(combo);
    if (entries.length === 0) return '(any tags)';
    return entries.map(([k, v]) => `${k}:${v}`).join(', ');
  }

  const title = document.createElement('div');
  title.className = 'rule-field-label';
  title.style.marginBottom = '4px';
  title.textContent = 'Resolved grid preview';
  container.appendChild(title);

  if (truncated) {
    const warn = document.createElement('p');
    warn.className = 'placeholder';
    warn.style.marginBottom = '4px';
    warn.textContent = `Tag combinations exceed ${CAP}; showing first ${CAP}. Filter axes: add fewer values to reduce columns.`;
    container.appendChild(warn);
  }

  const table = document.createElement('table');
  table.className = 'rule-grid';

  // Header row
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  const th0 = document.createElement('th');
  th0.textContent = 'Scenario \\ Tags';
  headerRow.appendChild(th0);
  for (const combo of columns) {
    const th = document.createElement('th');
    th.textContent = colLabel(combo);
    th.title = colLabel(combo);
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  table.appendChild(tbody);
  container.appendChild(table);

  // Cache to avoid duplicate fetches
  const cache = new Map();

  async function fetchCell(scenario, tags) {
    const key = `${scenario}|${JSON.stringify(tags)}`;
    if (cache.has(key)) return cache.get(key);
    const tagStr = Object.entries(tags).map(([k,v]) => `${k}:${v}`).join(',');
    const scenParam = scenario === '*' ? '' : scenario;
    const url = `/api/cultures/${encodeURIComponent(culture.id)}/resolve?eraId=${encodeURIComponent(eraId)}&scenario=${encodeURIComponent(scenParam)}&tags=${encodeURIComponent(tagStr)}`;
    try {
      const r = await fetch(url);
      const data = r.ok ? await r.json() : { assigns: {}, ruleId: null };
      cache.set(key, data);
      return data;
    } catch {
      return { assigns: {}, ruleId: null };
    }
  }

  function matColor(materialId) {
    if (!materialId) return null;
    const m = (culture.materials ?? []).find(m => m.id === materialId);
    return m?.color ?? null;
  }

  // Build rows and kick off fetches
  for (const scenario of scenarios) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.textContent = scenario;
    tr.appendChild(th);

    for (const combo of columns) {
      const td = document.createElement('td');
      td.className = 'rule-grid-cell';
      td.textContent = '…';
      tr.appendChild(td);

      // Fetch asynchronously and update cell
      fetchCell(scenario, combo).then(({ assigns, ruleId }) => {
        td.innerHTML = '';
        if (!assigns || Object.keys(assigns).length === 0) {
          td.textContent = '—';
          td.className = 'rule-grid-cell rule-grid-empty';
          return;
        }
        td.className = 'rule-grid-cell rule-grid-match';
        if (assigns.materialId) {
          const color = matColor(assigns.materialId);
          if (color) {
            const swatch = document.createElement('span');
            swatch.className = 'swatch';
            swatch.style.background = color;
            td.appendChild(swatch);
          }
          const mid = document.createElement('span');
          mid.className = 'grid-cell-mat';
          mid.textContent = assigns.materialId;
          td.appendChild(mid);
        }
        const ornIds = assigns.ornamentIds ?? [];
        if (ornIds.length > 0) {
          const badge = document.createElement('span');
          badge.className = 'grid-cell-orn-badge';
          badge.textContent = `+${ornIds.length} orn`;
          td.appendChild(badge);
        }
        if (ruleId) td.title = `from rule "${ruleId}"`;
      });
    }

    tbody.appendChild(tr);
  }
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
      <section id="panel-defaults"><h3>Defaults</h3><div class="panel-body"></div></section>
      <section id="panel-typology"><h3>Typology mix</h3><div class="panel-body"></div></section>
      <section id="panel-rules" class="panel-rules-full"><h3>Rules</h3><div class="panel-body"></div></section>
      <section id="panel-ornaments"><h3>Ornaments</h3><div class="panel-body"></div></section>
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

  renderDefaultsPanel(era, el.querySelector('#panel-defaults .panel-body'));
  renderTypologyPanel(era, el.querySelector('#panel-typology .panel-body'));
  renderOrnamentsPanel(era, el.querySelector('#panel-ornaments .panel-body'));
  const rulesPanelBody = el.querySelector('#panel-rules .panel-body');
  if (rulesPanelBody) {
    rulesPanelBody.innerHTML = '';
    renderRuleEditor({ eraId: era.id }, rulesPanelBody);
  }
}

/* ── Era panel: Defaults ─────────────────────────────────── */

function renderDefaultsPanel(era, body) {
  if (!body) return;
  const d = era.defaults ?? {};
  const props = d.proportions ?? {};
  const palette = d.palette ?? [];
  const densityValues = ['sparse', 'moderate', 'dense', 'saturated'];

  function save() { savePartial({ eras: state.culture.eras }); }

  // Build the form
  const form = document.createElement('div');
  form.className = 'defaults-form';

  // Roof type
  const roofRow = document.createElement('div');
  roofRow.className = 'field-row';
  roofRow.innerHTML = `<label>Roof type</label><input type="text" class="field-input" value="${esc(d.roofType ?? '')}" placeholder="e.g. gabled">`;
  roofRow.querySelector('input').addEventListener('input', e => {
    if (!era.defaults) era.defaults = {};
    era.defaults.roofType = e.target.value;
    save();
  });
  form.appendChild(roofRow);

  // Technique
  const techRow = document.createElement('div');
  techRow.className = 'field-row';
  techRow.innerHTML = `<label>Technique</label><input type="text" class="field-input" value="${esc(d.technique ?? '')}" placeholder="e.g. dressed stone">`;
  techRow.querySelector('input').addEventListener('input', e => {
    if (!era.defaults) era.defaults = {};
    era.defaults.technique = e.target.value;
    save();
  });
  form.appendChild(techRow);

  // Proportions
  const propSection = document.createElement('div');
  propSection.className = 'defaults-section';
  const propLabel = document.createElement('div');
  propLabel.className = 'field-label';
  propLabel.textContent = 'Proportions';
  propSection.appendChild(propLabel);

  const propDefs = [
    { key: 'columnSlenderness', label: 'Col. slenderness' },
    { key: 'storyHeight',       label: 'Story height' },
    { key: 'doorAspect',        label: 'Door aspect' },
  ];
  for (const { key, label } of propDefs) {
    const val = props[key] ?? 1;
    const row = document.createElement('div');
    row.className = 'field-row';
    row.innerHTML = `<label>${esc(label)}</label>
      <div class="prop-input-wrap">
        <input type="number" step="0.05" min="0.1" max="5" class="field-input" value="${val}" data-prop="${key}">
        <span class="prop-val">${Number(val).toFixed(2)}</span>
      </div>`;
    const input = row.querySelector('input');
    const valEl = row.querySelector('.prop-val');
    input.addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      if (!isNaN(v)) {
        valEl.textContent = v.toFixed(2);
        if (!era.defaults) era.defaults = {};
        if (!era.defaults.proportions) era.defaults.proportions = {};
        era.defaults.proportions[key] = v;
        save();
      }
    });
    propSection.appendChild(row);
  }
  form.appendChild(propSection);

  // Palette
  const paletteSection = document.createElement('div');
  paletteSection.className = 'defaults-section';
  const paletteLabel = document.createElement('div');
  paletteLabel.className = 'field-label';
  paletteLabel.textContent = 'Palette';
  paletteSection.appendChild(paletteLabel);

  const paletteList = document.createElement('div');
  paletteList.className = 'palette-list';

  function renderPaletteRows() {
    paletteList.innerHTML = '';
    const currentPalette = era.defaults?.palette ?? [];
    currentPalette.forEach((color, idx) => {
      const row = document.createElement('div');
      row.className = 'palette-row';
      row.innerHTML = `<input type="color" value="${esc(color)}"><button class="icon-btn-sm palette-remove" title="Remove color">×</button>`;
      row.querySelector('input[type=color]').addEventListener('input', e => {
        if (!era.defaults) era.defaults = {};
        if (!era.defaults.palette) era.defaults.palette = [];
        era.defaults.palette[idx] = e.target.value;
        save();
      });
      row.querySelector('.palette-remove').addEventListener('click', () => {
        if (!era.defaults) era.defaults = {};
        era.defaults.palette = (era.defaults.palette ?? []).filter((_, i) => i !== idx);
        save();
        renderPaletteRows();
      });
      paletteList.appendChild(row);
    });
  }

  renderPaletteRows();
  paletteSection.appendChild(paletteList);

  const addColorBtn = document.createElement('button');
  addColorBtn.className = 'add-btn-sm';
  addColorBtn.textContent = '+ Add color';
  addColorBtn.addEventListener('click', () => {
    if (!era.defaults) era.defaults = {};
    if (!era.defaults.palette) era.defaults.palette = [];
    era.defaults.palette.push('#888888');
    save();
    renderPaletteRows();
  });
  paletteSection.appendChild(addColorBtn);
  form.appendChild(paletteSection);

  // Ornament density segmented control
  const densitySection = document.createElement('div');
  densitySection.className = 'defaults-section';
  const densityLabel = document.createElement('div');
  densityLabel.className = 'field-label';
  densityLabel.textContent = 'Ornament density';
  densitySection.appendChild(densityLabel);

  const segWrap = document.createElement('div');
  segWrap.className = 'segmented';

  function renderSegmented() {
    segWrap.innerHTML = '';
    const current = era.defaults?.ornamentDensity ?? 'moderate';
    for (const val of densityValues) {
      const btn = document.createElement('button');
      btn.textContent = val;
      btn.className = val === current ? 'active' : '';
      btn.addEventListener('click', () => {
        if (!era.defaults) era.defaults = {};
        era.defaults.ornamentDensity = val;
        save();
        renderSegmented();
      });
      segWrap.appendChild(btn);
    }
  }

  renderSegmented();
  densitySection.appendChild(segWrap);
  form.appendChild(densitySection);

  body.innerHTML = '';
  body.appendChild(form);
}

/* ── Era panel: Typology mix ─────────────────────────────── */

function renderTypologyPanel(era, body) {
  if (!body) return;
  const mix = era.typologyMix ?? {};
  const entries = Object.entries(mix);

  function save() { savePartial({ eras: state.culture.eras }); }

  const wrap = document.createElement('div');
  wrap.className = 'typology-wrap';

  const list = document.createElement('div');
  list.className = 'typology-list';

  function renderRows() {
    list.innerHTML = '';
    const currentMix = era.typologyMix ?? {};
    const keys = Object.keys(currentMix);
    if (keys.length === 0) {
      const ph = document.createElement('p');
      ph.className = 'placeholder';
      ph.textContent = 'No typologies yet. Click + to add one.';
      list.appendChild(ph);
      return;
    }
    keys.forEach(typId => {
      const weight = currentMix[typId];
      const row = document.createElement('div');
      row.className = 'typology-row';
      row.innerHTML = `
        <input type="text" class="field-input-sm typ-id" value="${esc(typId)}" placeholder="typology-id">
        <input type="range" class="typ-slider" min="0" max="1" step="0.01" value="${weight}">
        <span class="typ-val">${fmt(weight)}</span>
        <button class="icon-btn-sm typ-remove" title="Remove">×</button>
      `;
      const idInput = row.querySelector('.typ-id');
      const slider  = row.querySelector('.typ-slider');
      const valEl   = row.querySelector('.typ-val');

      idInput.addEventListener('change', e => {
        const newId = e.target.value.trim();
        if (!newId || newId === typId) return;
        const v = currentMix[typId];
        delete era.typologyMix[typId];
        era.typologyMix[newId] = v;
        save();
        renderRows();
      });

      slider.addEventListener('input', e => {
        const v = parseFloat(e.target.value);
        valEl.textContent = fmt(v);
        era.typologyMix[typId] = v;
        save();
      });

      row.querySelector('.typ-remove').addEventListener('click', () => {
        delete era.typologyMix[typId];
        save();
        renderRows();
      });

      list.appendChild(row);
    });
  }

  renderRows();

  let addCounter = 0;
  const addBtn = document.createElement('button');
  addBtn.className = 'add-btn';
  addBtn.textContent = '+ Add typology';
  addBtn.addEventListener('click', () => {
    if (!era.typologyMix) era.typologyMix = {};
    let newId = `new-typology-${++addCounter}`;
    while (newId in era.typologyMix) newId = `new-typology-${++addCounter}`;
    era.typologyMix[newId] = 1.0;
    save();
    renderRows();
  });

  wrap.appendChild(list);
  wrap.appendChild(addBtn);
  body.innerHTML = '';
  body.appendChild(wrap);
}

/* ── Era panel: Ornaments (navigation shortcut) ──────────── */

function renderOrnamentsPanel(era, body) {
  if (!body) return;

  const note = document.createElement('p');
  note.className = 'placeholder ornaments-note';
  note.textContent = 'Ornaments are selected by rules in this culture. Edit the culture\'s ornament library or rules to control what appears in this era.';
  body.appendChild(note);

  const btnWrap = document.createElement('div');
  btnWrap.className = 'shortcut-buttons';

  const libBtn = document.createElement('button');
  libBtn.className = 'add-btn-sm';
  libBtn.textContent = 'Open ornament library';
  libBtn.addEventListener('click', () => {
    state.subtab = 'ornaments';
    document.querySelectorAll('#studio-subtabs button').forEach(b => {
      b.classList.toggle('active', b.dataset.subtab === 'ornaments');
    });
    renderSubtab();
    document.getElementById('subtab-body')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  const rulesBtn = document.createElement('button');
  rulesBtn.className = 'add-btn-sm';
  rulesBtn.textContent = 'Open rules';
  rulesBtn.addEventListener('click', () => {
    state.subtab = 'culture-rules';
    document.querySelectorAll('#studio-subtabs button').forEach(b => {
      b.classList.toggle('active', b.dataset.subtab === 'culture-rules');
    });
    renderSubtab();
    document.getElementById('subtab-body')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  btnWrap.appendChild(libBtn);
  btnWrap.appendChild(rulesBtn);
  body.appendChild(btnWrap);

  // Collect ornament ids from all rules (era rules + culture rules)
  // v2: filter by actual era-scoped resolution
  const allRules = [
    ...(era.rules ?? []),
    ...(state.culture?.rules ?? []),
  ];
  const ornamentIds = new Set();
  for (const rule of allRules) {
    const ids = rule.assigns?.ornamentIds;
    if (Array.isArray(ids)) ids.forEach(id => ornamentIds.add(id));
    else if (typeof ids === 'string' && ids) ornamentIds.add(ids);
  }

  if (ornamentIds.size > 0) {
    const pillsLabel = document.createElement('div');
    pillsLabel.className = 'field-label';
    pillsLabel.style.marginTop = '8px';
    pillsLabel.textContent = 'Ornaments referenced by rules';
    body.appendChild(pillsLabel);

    const pills = document.createElement('ul');
    pills.className = 'ornament-pills';
    for (const id of ornamentIds) {
      const li = document.createElement('li');
      li.className = 'ornament-pill';
      li.textContent = id;
      pills.appendChild(li);
    }
    body.appendChild(pills);
  } else {
    const empty = document.createElement('p');
    empty.className = 'placeholder';
    empty.style.marginTop = '6px';
    empty.textContent = 'No ornament ids referenced in any rule yet.';
    body.appendChild(empty);
  }
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

/* ── SSE live-reload ─────────────────────────────────────── */
// v2 note: if the user's own PATCH triggers a file-write which emits an SSE
// event back to the same client, we will re-render (~200 ms after save).
// Deduplicating own-writes is left for v2 — the 200 ms file-watcher debounce
// keeps storms under control in v1.

function reRenderOpenCulture() {
  if (!state.culture) return;
  renderHeader();
  // Skip sub-tab body re-render if the user is actively typing inside it.
  // Known small bug (v2): two clients editing the same culture will miss
  // remote updates while one is focused in an input.
  if (!document.activeElement || !document.getElementById('subtab-body').contains(document.activeElement)) {
    renderSubtab();
  }
  renderTimeline();
  if (!document.activeElement || !document.getElementById('era-detail').contains(document.activeElement)) {
    renderEraDetail();
  }
}

let lastErrorLog = 0;
function setupSse() {
  let es;
  try {
    es = new EventSource('/api/events');
  } catch (e) {
    console.warn('SSE not available:', e);
    return;
  }
  es.addEventListener('culture-changed', async (ev) => {
    let payload;
    try { payload = JSON.parse(ev.data); } catch { return; }
    const changedId = payload?.id;
    if (changedId && state.selectedId === changedId) {
      try {
        state.culture = await api.get(state.selectedId);
        reRenderOpenCulture();
      } catch (e) {
        console.warn('Failed to refresh on culture-changed', e);
      }
    }
    // Always refresh list to pick up adds/deletes.
    try { await refreshList(); } catch {}
  });
  es.addEventListener('error', () => {
    const now = Date.now();
    if (now - lastErrorLog > 5000) {
      lastErrorLog = now;
      console.warn('SSE connection error (auto-reconnecting)');
    }
  });
}

/* ── Boot ────────────────────────────────────────────────── */

refreshList();
setupSse();
