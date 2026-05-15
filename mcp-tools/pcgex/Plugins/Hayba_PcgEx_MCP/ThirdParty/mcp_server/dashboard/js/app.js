// ── Hayba PCGEx Dashboard ──────────────────────────────────────────────────

const API = {
  health:    () => fetch('/api/health').then(r => r.json()),
  ueStatus:  () => fetch('/api/ue/status').then(r => r.json()),
  assets:    (path) => fetch(`/api/ue/assets?path=${encodeURIComponent(path || '/Game/')}`).then(r => r.json()),
  catalog:   () => fetch('/api/catalog').then(r => r.json()),
  search:    (q) => fetch(`/api/catalog/search?q=${encodeURIComponent(q)}`).then(r => r.json()),
  validate:  (graph) => fetch('/api/ue/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ graph })
  }).then(r => r.json()),
  exportGraph: (assetPath) => fetch(`/api/ue/graph?assetPath=${encodeURIComponent(assetPath)}`).then(r => r.json()),
};

// ── Router ────────────────────────────────────────────────────────────────

const router = {
  current: null,
  go(pageId) {
    if (this.current === pageId) return;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const page = document.getElementById(`page-${pageId}`);
    const nav  = document.querySelector(`[data-page="${pageId}"]`);
    if (page) page.classList.add('active');
    if (nav)  nav.classList.add('active');
    this.current = pageId;
    pages[pageId]?.onEnter?.();
  }
};

// ── Activity Log ──────────────────────────────────────────────────────────

const log = (() => {
  const entries = [];
  const MAX = 200;

  function add(level, msg) {
    const now = new Date();
    const time = now.toTimeString().slice(0, 8);
    entries.unshift({ time, level, msg });
    if (entries.length > MAX) entries.pop();
    render();
  }

  function render() {
    const el = document.getElementById('activity-log');
    if (!el) return;
    el.innerHTML = entries.slice(0, 80).map(e => `
      <div class="log-entry">
        <span class="log-time">${e.time}</span>
        <span class="log-level ${e.level}">${e.level}</span>
        <span class="log-msg">${e.msg}</span>
      </div>
    `).join('');
  }

  return { info: m => add('info', m), ok: m => add('ok', m), warn: m => add('warn', m), error: m => add('error', m), render };
})();

// ── UE Status Polling ─────────────────────────────────────────────────────

const ueMonitor = (() => {
  let interval = null;
  let lastConnected = null;

  async function poll() {
    try {
      const [health, ue] = await Promise.all([API.health(), API.ueStatus()]);

      // Titlebar badge
      const badge = document.getElementById('ue-status-badge');
      const uptimeEl = document.getElementById('server-uptime');

      if (badge) {
        badge.textContent = ue.connected ? `● UE5 ${ue.ueVersion || ''}`.trim() : '○ UE5 OFFLINE';
        badge.className = 'ue-status-badge ' + (ue.connected ? 'connected' : 'error');
      }

      const uptime = Math.floor(health.uptime);
      const h = Math.floor(uptime / 3600), m = Math.floor((uptime % 3600) / 60), s = uptime % 60;
      if (uptimeEl) uptimeEl.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;

      // Status page cards
      document.getElementById('st-ue-status')?.setAttribute('data-connected', ue.connected);
      const stUE  = document.getElementById('st-ue-val');
      const stPlg = document.getElementById('st-plugin-val');
      const stUEV = document.getElementById('st-ueversion-val');
      const stPort = document.getElementById('st-port-val');
      const stTcp  = document.getElementById('st-tcp-val');

      if (stUE)   { stUE.textContent   = ue.connected ? 'CONNECTED' : 'OFFLINE'; stUE.className = 'metric-val ' + (ue.connected ? 'green' : 'red'); }
      if (stPlg)  { stPlg.textContent  = ue.plugin || '—'; stPlg.className = 'metric-val cyan'; }
      if (stUEV)  { stUEV.textContent  = ue.ueVersion || '—'; }
      if (stPort) { stPort.textContent = health.port || '—'; stPort.className = 'metric-val amber'; }
      if (stTcp)  { stTcp.textContent  = health.ueTcpTarget || '—'; }

      if (ue.connected !== lastConnected) {
        log[ue.connected ? 'ok' : 'warn'](ue.connected ? `UE5 connected — ${ue.plugin} v${ue.pluginVersion}` : 'UE5 disconnected');
        lastConnected = ue.connected;
      }
    } catch (err) {
      log.error(`Health check failed: ${err.message}`);
    }
  }

  return {
    start() { poll(); interval = setInterval(poll, 4000); },
    stop()  { clearInterval(interval); }
  };
})();

// ── Pages ─────────────────────────────────────────────────────────────────

const pages = {

  // ── Status Page ─────────────────────────────────────────────────────────
  status: {
    onEnter() {
      log.render();
      log.info('Viewing status dashboard');
    }
  },

  // ── Assets Page ─────────────────────────────────────────────────────────
  assets: {
    data: [],
    filter: '',

    async onEnter() {
      log.info('Loading PCG assets…');
      this.render({ loading: true });
      try {
        const res = await API.assets('/Game/');
        this.data = res.assets || [];
        log.ok(`Loaded ${this.data.length} assets`);
        this.render();
      } catch (err) {
        log.error(`Assets fetch failed: ${err.message}`);
        this.render({ error: err.message });
      }
    },

    filtered() {
      if (!this.filter) return this.data;
      const q = this.filter.toLowerCase();
      return this.data.filter(a => a.name.toLowerCase().includes(q) || a.path.toLowerCase().includes(q));
    },

    render({ loading, error } = {}) {
      const tbody = document.getElementById('assets-tbody');
      const count = document.getElementById('assets-count');
      if (!tbody) return;

      if (loading) {
        tbody.innerHTML = `<tr><td colspan="4"><div class="loading"><div class="spinner"></div>Fetching assets from UE5…</div></td></tr>`;
        return;
      }
      if (error) {
        tbody.innerHTML = `<tr><td colspan="4" style="color:var(--red);padding:16px">Error: ${error}</td></tr>`;
        return;
      }

      const items = this.filtered();
      if (count) count.textContent = `${items.length} / ${this.data.length}`;

      tbody.innerHTML = items.map(a => `
        <tr data-path="${a.path}" onclick="pages.assets.select(this, '${a.path}')">
          <td class="asset-name">${a.name}</td>
          <td class="asset-path">${a.path}</td>
          <td><span class="badge">${a.nodeCount ?? '?'} nodes</span></td>
          <td><span class="badge">${a.edgeCount ?? '?'} edges</span></td>
        </tr>
      `).join('') || `<tr><td colspan="4" style="color:var(--text-2);padding:16px;text-align:center">No assets found</td></tr>`;
    },

    select(row, path) {
      document.querySelectorAll('#assets-tbody tr').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      log.info(`Selected: ${path}`);
    }
  },

  // ── Catalog Page ─────────────────────────────────────────────────────────
  catalog: {
    data: null,
    activeCategory: null,
    searchQuery: '',

    async onEnter() {
      if (this.data) { this.render(); return; }
      log.info('Loading node catalog…');
      try {
        const res = await API.catalog();
        this.data = res;
        // Extract categories from common_workflows or categories field
        this.categories = res.categories || {};
        this.buildCategoryList();
        log.ok('Catalog loaded');
      } catch (err) {
        log.error(`Catalog load failed: ${err.message}`);
      }
    },

    buildCategoryList() {
      const el = document.getElementById('catalog-categories');
      if (!el) return;
      const cats = Object.entries(this.categories || {});
      el.innerHTML = cats.map(([name, nodes]) => `
        <div class="category-item" onclick="pages.catalog.filterBy('${name}')" data-cat="${name}">
          <span>${name}</span>
          <span class="category-count">${Array.isArray(nodes) ? nodes.length : 0}</span>
        </div>
      `).join('') || '<div style="padding:12px;color:var(--text-2);font-size:10px">No categories</div>';
    },

    async search(q) {
      this.searchQuery = q;
      if (!q) { this.activeCategory = null; this.render(); return; }
      log.info(`Searching: "${q}"`);
      try {
        const res = await API.search(q);
        this.renderNodes(res.results || []);
      } catch (err) {
        log.error(`Search failed: ${err.message}`);
      }
    },

    filterBy(cat) {
      this.activeCategory = cat;
      document.querySelectorAll('.category-item').forEach(el => el.classList.toggle('active', el.dataset.cat === cat));
      const nodes = this.categories[cat] || [];
      this.renderNodes(nodes);
      log.info(`Category: ${cat} (${Array.isArray(nodes) ? nodes.length : 0} nodes)`);
    },

    render() {
      this.buildCategoryList();
      const el = document.getElementById('catalog-results');
      if (el) el.innerHTML = `<div class="empty-state"><div class="empty-icon">⬡</div><div class="empty-label">Select a category or search</div></div>`;
    },

    renderNodes(nodes) {
      const el = document.getElementById('catalog-results');
      if (!el) return;
      if (!nodes.length) {
        el.innerHTML = `<div class="empty-state"><div class="empty-icon">∅</div><div class="empty-label">No results</div></div>`;
        return;
      }
      el.innerHTML = nodes.map(n => {
        const name = n.class || n.name || n;
        const desc = n.description || n.desc || '';
        const inputs  = (n.inputs  || []).map(p => `<span class="pin-tag">${typeof p === 'string' ? p : (p.name || p.label || '')}</span>`).join('');
        const outputs = (n.outputs || []).map(p => `<span class="pin-tag out">${typeof p === 'string' ? p : (p.name || p.label || '')}</span>`).join('');
        return `
          <div class="node-card">
            <div class="node-class">${name}</div>
            ${desc ? `<div class="node-desc">${desc}</div>` : ''}
            ${(inputs || outputs) ? `<div class="pin-list">${inputs}${outputs}</div>` : ''}
          </div>
        `;
      }).join('');
    }
  },

  // ── Validate Page ─────────────────────────────────────────────────────────
  validate: {
    onEnter() {
      log.info('Validate page ready — paste graph JSON and run');
    },

    async run() {
      const ta = document.getElementById('validate-input');
      const raw = ta?.value?.trim();
      if (!raw) { log.warn('No input to validate'); return; }

      let graph;
      try {
        graph = JSON.parse(raw);
      } catch {
        this.showResults([{ type: 'error', detail: 'Invalid JSON — cannot parse input', node: '' }]);
        return;
      }

      log.info('Running validation…');
      const btn = document.getElementById('validate-btn');
      if (btn) { btn.textContent = 'RUNNING…'; btn.disabled = true; }

      try {
        const res = await API.validate(JSON.stringify(graph));
        const errors = res.errors || [];
        log[errors.length ? 'warn' : 'ok'](`Validation: ${errors.length ? errors.length + ' issue(s)' : 'VALID'}`);
        if (errors.length === 0) {
          this.showResults([{ type: 'valid', detail: `Graph is valid — ${graph.nodes?.length ?? '?'} nodes, ${graph.edges?.length ?? '?'} edges`, node: '' }]);
        } else {
          this.showResults(errors);
        }
      } catch (err) {
        // If UE offline, do local schema check
        log.warn('UE offline — running local schema check');
        this.localValidate(graph);
      } finally {
        if (btn) { btn.textContent = 'VALIDATE'; btn.disabled = false; }
      }
    },

    localValidate(graph) {
      const errors = [];
      if (!graph.nodes) errors.push({ type: 'error', detail: 'Missing required field: nodes', node: '' });
      if (!graph.edges) errors.push({ type: 'error', detail: 'Missing required field: edges', node: '' });
      if (graph.nodes && graph.edges) {
        const nodeIds = new Set(graph.nodes.map(n => n.id));
        for (const e of graph.edges) {
          if (!nodeIds.has(e.fromNode)) errors.push({ type: 'error', detail: `Dangling edge: unknown source node "${e.fromNode}"`, node: e.fromNode });
          if (!nodeIds.has(e.toNode))   errors.push({ type: 'error', detail: `Dangling edge: unknown target node "${e.toNode}"`, node: e.toNode });
        }
        for (const n of graph.nodes) {
          if (!n.id)    errors.push({ type: 'error', detail: 'Node missing id', node: '' });
          if (!n.class) errors.push({ type: 'error', detail: 'Node missing class', node: n.id || '' });
        }
      }
      if (!errors.length) errors.push({ type: 'valid', detail: 'Schema looks OK (local check — UE offline)', node: '' });
      this.showResults(errors);
    },

    showResults(items) {
      const el = document.getElementById('validate-results');
      if (!el) return;
      el.innerHTML = items.map(e => `
        <div class="result-item ${e.type === 'valid' ? 'valid' : e.type === 'error' ? 'error' : 'warn'}">
          <div class="result-type">${e.type}</div>
          <div class="result-detail">${e.detail || e.message || JSON.stringify(e)}</div>
          ${e.node ? `<div class="result-node">node: ${e.node}${e.pin ? ' · pin: ' + e.pin : ''}</div>` : ''}
        </div>
      `).join('');
    }
  },

  // ── Graph Viewer Page ─────────────────────────────────────────────────────
  graph: {
    cy: null,
    assets: [],

    async onEnter() {
      if (!this.assets.length) await this.loadAssets();
      this.initCy();
    },

    async loadAssets() {
      try {
        const res = await API.assets('/Game/');
        this.assets = res.assets || [];
        const el = document.getElementById('graph-asset-list');
        if (!el) return;
        el.innerHTML = this.assets.map(a => `
          <div class="graph-asset-item" onclick="pages.graph.load('${a.path}')" title="${a.path}">${a.name}</div>
        `).join('') || '<div style="padding:12px;color:var(--text-2);font-size:10px">No assets</div>';
        log.ok(`${this.assets.length} assets available`);
      } catch (err) {
        log.error(`Failed to load asset list: ${err.message}`);
      }
    },

    initCy() {
      if (this.cy || typeof cytoscape === 'undefined') return;
      this.cy = cytoscape({
        container: document.getElementById('cy-container'),
        style: [
          { selector: 'node', style: {
            'label': 'data(label)',
            'text-valign': 'center',
            'text-halign': 'center',
            'font-family': 'IBM Plex Mono, monospace',
            'font-size': '9px',
            'color': '#a0a0a0',
            'background-color': '#1e1e1e',
            'border-width': 1,
            'border-color': '#2a2a2a',
            'width': 140,
            'height': 36,
            'shape': 'roundrectangle',
            'text-max-width': '130px',
            'text-wrap': 'ellipsis',
            'padding': '6px',
          }},
          { selector: 'node[type="PCGEx"]', style: { 'border-color': '#006880', 'color': '#00d4ff' } },
          { selector: 'node[type="Debug"]',  style: { 'border-color': '#7a5200', 'color': '#f0a500' } },
          { selector: 'node:selected', style: { 'border-color': '#00d4ff', 'border-width': 2, 'background-color': '#0d2a30' } },
          { selector: 'edge', style: {
            'width': 1,
            'line-color': '#2a2a2a',
            'target-arrow-color': '#2a2a2a',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            'arrow-scale': 0.6,
            'label': 'data(label)',
            'font-family': 'IBM Plex Mono, monospace',
            'font-size': '8px',
            'color': '#585858',
            'text-background-color': '#080808',
            'text-background-opacity': 1,
            'text-background-padding': '2px',
          }},
        ],
        elements: [],
        layout: { name: 'preset' },
        userZoomingEnabled: true,
        userPanningEnabled: true,
        minZoom: 0.2,
        maxZoom: 3,
      });

      this.cy.on('tap', 'node', evt => {
        const data = evt.target.data();
        this.inspect(data);
      });
    },

    async load(assetPath) {
      document.querySelectorAll('.graph-asset-item').forEach(el => el.classList.toggle('active', el.title === assetPath));
      log.info(`Loading graph: ${assetPath}`);

      const inspector = document.getElementById('graph-inspector');
      if (inspector) inspector.innerHTML = '<div class="loading"><div class="spinner"></div>Loading…</div>';

      try {
        const res = await API.exportGraph(assetPath);
        const g = res.graph || res;
        if (!g || !g.nodes) throw new Error('No graph data returned');
        this.renderGraph(g);
        log.ok(`Graph loaded: ${g.nodes.length} nodes, ${g.edges.length} edges`);
      } catch (err) {
        log.error(`Graph load failed: ${err.message}`);
        if (inspector) inspector.innerHTML = `<div style="padding:12px;color:var(--red);font-size:10px">Error: ${err.message}</div>`;
      }
    },

    renderGraph(g) {
      if (!this.cy) this.initCy();
      if (!this.cy) return;

      const elements = [
        ...g.nodes.map(n => ({
          data: {
            id: n.id,
            label: n.label || n.class,
            class: n.class,
            properties: n.properties,
            type: n.class?.startsWith('PCGEx') ? 'PCGEx' : n.class?.includes('Debug') ? 'Debug' : 'PCG',
          },
          position: n.position ? { x: n.position.x, y: n.position.y } : undefined,
        })),
        ...g.edges.map((e, i) => ({
          data: {
            id: `e${i}`,
            source: e.fromNode,
            target: e.toNode,
            label: `${e.fromPin}→${e.toPin}`,
          }
        })),
      ];

      this.cy.elements().remove();
      this.cy.add(elements);

      // Use preset layout if positions exist, else dagre/breadthfirst
      const hasPositions = g.nodes.every(n => n.position);
      if (!hasPositions) {
        this.cy.layout({ name: 'breadthfirst', directed: true, padding: 40 }).run();
      } else {
        this.cy.fit(undefined, 40);
      }
    },

    inspect(data) {
      const el = document.getElementById('graph-inspector');
      if (!el) return;
      const props = data.properties || {};
      const rows = Object.entries(props)
        .filter(([k, v]) => v && String(v).length < 80 && !k.startsWith('b') )
        .slice(0, 20)
        .map(([k, v]) => `<div class="inspector-row"><span class="inspector-key">${k}</span><span class="inspector-val">${v}</span></div>`)
        .join('');

      el.innerHTML = `
        <div class="pane-header">
          <span>${data.label}</span>
        </div>
        <div class="inspector-content">
          <div class="inspector-row"><span class="inspector-key" style="color:var(--cyan)">class</span><span class="inspector-val" style="color:var(--cyan)">${data.class}</span></div>
          <div class="inspector-row"><span class="inspector-key">id</span><span class="inspector-val">${data.id}</span></div>
          ${rows}
        </div>
      `;
    }
  }
};

// ── Init ──────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Nav
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => router.go(el.dataset.page));
  });

  // Assets search
  const assetSearch = document.getElementById('asset-search');
  if (assetSearch) {
    assetSearch.addEventListener('input', e => {
      pages.assets.filter = e.target.value;
      pages.assets.render();
    });
  }

  // Assets refresh
  document.getElementById('assets-refresh')?.addEventListener('click', () => pages.assets.onEnter());

  // Catalog search
  const catSearch = document.getElementById('catalog-search-input');
  let catSearchTimer;
  if (catSearch) {
    catSearch.addEventListener('input', e => {
      clearTimeout(catSearchTimer);
      catSearchTimer = setTimeout(() => pages.catalog.search(e.target.value), 300);
    });
  }

  // Validate
  document.getElementById('validate-btn')?.addEventListener('click', () => pages.validate.run());
  document.getElementById('validate-clear')?.addEventListener('click', () => {
    const ta = document.getElementById('validate-input');
    if (ta) ta.value = '';
    const el = document.getElementById('validate-results');
    if (el) el.innerHTML = `<div class="empty-state"><div class="empty-icon">✓</div><div class="empty-label">Paste graph JSON and validate</div></div>`;
  });

  // Start
  log.info('Hayba PCGEx Dashboard initialized');
  ueMonitor.start();
  router.go('status');
});
