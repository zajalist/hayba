/**
 * Hayba Architecture Atlas — SVG vertex editor (browser module).
 *
 * Public API:
 *   - openEditor(bindingKey, opts): void
 *   - closeEditor(): void
 *   - hasUnsavedChanges(): boolean
 *   - editorOpenSlot(slotName): void
 *   - editorSelectTool(toolName): void
 *   - editorToggleSnap(): void
 *   - editorSave(): Promise<void>   -- stub in this batch; real impl in Batch 5
 *   - editorRefresh(): void
 */

import * as paper from 'paper';
import {
  verticesToSvgPath, parsePathD, applyHint,
  fitViewBox, snap,
  loadElementCatalog,
  registerBinding, emitElementMesh,
} from '../dist/index.js';

/* ─── module-local state ──────────────────────────────────────────────── */

const state = {
  active: false,
  bindingKey: null,
  binding: null,
  element: null,
  activeSlot: null,
  slots: {},
  tool: 'select',
  snapGrid: 5,
  paperScope: null,
  saveCallback: null,
  bindingsRef: null,
  kernelRef: null,
};

/* ─── public API ─────────────────────────────────────────────────────── */

export function openEditor(bindingKey, opts) {
  state.bindingKey = bindingKey;
  state.saveCallback = opts?.onSave ?? null;
  state.bindingsRef = opts?.bindingsRef ?? null;
  state.kernelRef = opts?.kernelRef ?? null;

  const binding = state.bindingsRef?.[bindingKey];
  if (!binding) {
    console.error(`openEditor: no binding for ${bindingKey}`);
    return;
  }
  const catalog = loadElementCatalog();
  const element = catalog.elementsById.get(binding.elementId);
  if (!element) {
    console.error(`openEditor: no element ${binding.elementId}`);
    return;
  }
  state.binding = binding;
  state.element = element;
  state.slots = {};
  for (const slotDef of element.profileSlots) {
    const svgStr = binding.profiles[slotDef.name];
    if (typeof svgStr !== 'string') continue;
    const dMatch = svgStr.match(/<path\b[^>]*\bd\s*=\s*"([^"]+)"/);
    const vbMatch = svgStr.match(/viewBox\s*=\s*"([^"]+)"/);
    if (!dMatch || !vbMatch) continue;
    const [vx, vy, vw, vh] = vbMatch[1].trim().split(/\s+/).map(Number);
    let vertices;
    try {
      vertices = parsePathD(dMatch[1]);
    } catch (err) {
      console.warn(`openEditor: cannot parse ${slotDef.name} (likely curve commands):`, err.message);
      continue;
    }
    state.slots[slotDef.name] = {
      slotName: slotDef.name,
      hint: slotDef.hint,
      viewBox: [vx, vy, vw, vh],
      vertices,
      dirty: false,
      originalSvg: svgStr,
      paperPath: null,
      paperHandles: null,
      cachedView: null,
    };
  }
  state.activeSlot = element.profileSlots[0]?.name ?? null;
  state.active = true;

  _initPaper();
  _renderSlotTabs();
  _loadSlotIntoCanvas(state.activeSlot);
  _refreshStatus();
  _refreshSaveButton();
  _refreshBreadcrumb();
}

export function closeEditor() {
  if (state.paperScope) {
    try { state.paperScope.project?.clear(); } catch {}
    state.paperScope = null;
  }
  state.active = false;
  state.bindingKey = null;
  state.binding = null;
  state.element = null;
  state.activeSlot = null;
  state.slots = {};
}

export function hasUnsavedChanges() {
  return Object.values(state.slots).some((s) => s.dirty);
}

export function editorOpenSlot(slotName) {
  if (!state.slots[slotName]) return;
  state.activeSlot = slotName;
  _loadSlotIntoCanvas(slotName);
  _renderSlotTabs();
  _refreshStatus();
}

export function editorSelectTool(toolName) {
  state.tool = toolName;
  for (const btn of document.querySelectorAll('.editor-tool-btn[data-tool]')) {
    if (btn.dataset.tool === 'snap') continue;
    btn.classList.toggle('active', btn.dataset.tool === toolName);
  }
  const canvas = document.getElementById('editorCanvas');
  if (canvas) {
    canvas.style.cursor =
      toolName === 'select' ? 'crosshair' :
      toolName === 'pen'    ? 'cell' :
      toolName === 'pan'    ? 'grab' :
      toolName === 'zoom'   ? 'zoom-in' :
      'default';
  }
}

export function editorToggleSnap() {
  state.snapGrid = state.snapGrid === 0 ? 5 : 0;
  document.getElementById('editorSnapBtn')?.classList.toggle('active', state.snapGrid > 0);
  // Reload current slot to re-render grid.
  if (state.activeSlot) _loadSlotIntoCanvas(state.activeSlot);
  _refreshStatus();
}

export async function editorSave() {
  // Stub — Batch 5 fills this in.
  console.warn('editorSave: not yet implemented (Task 11)');
}

export function editorRefresh() {
  if (!state.active) return;
  _refreshStatus();
  _refreshSaveButton();
  _refreshBreadcrumb();
  _renderSlotTabs();
}

/* ─── Paper.js init + per-slot loading ──────────────────────────────── */

function _initPaper() {
  const canvas = document.getElementById('editorCanvas');
  if (!canvas) return;
  if (!state.paperScope) {
    paper.install(window);
    paper.setup(canvas);
    state.paperScope = paper;
    _setupTools();
  }
}

function _loadSlotIntoCanvas(slotName) {
  const slot = state.slots[slotName];
  if (!slot || !state.paperScope) return;
  const ps = state.paperScope;
  ps.project.clear();

  const canvas = document.getElementById('editorCanvas');
  const view = { canvasSize: { w: canvas.clientWidth, h: canvas.clientHeight }, viewBox: slot.viewBox };

  // ── viewBox outline (dashed) ──
  const [vbX, vbY, vbW, vbH] = slot.viewBox;
  const tlCanvas = _svgToCanvas({ sx: vbX, sy: vbY + vbH }, view);
  const brCanvas = _svgToCanvas({ sx: vbX + vbW, sy: vbY }, view);
  const lotRect = new ps.Path.Rectangle({
    from: [tlCanvas.px, tlCanvas.py],
    to: [brCanvas.px, brCanvas.py],
  });
  lotRect.strokeColor = '#3d434e';
  lotRect.dashArray = [3, 3];
  lotRect.strokeWidth = 1;
  lotRect.data.role = 'viewbox';

  // ── grid lines ──
  if (state.snapGrid > 0) {
    const grid = new ps.Group();
    for (let x = vbX; x <= vbX + vbW; x += state.snapGrid) {
      const a = _svgToCanvas({ sx: x, sy: vbY }, view);
      const b = _svgToCanvas({ sx: x, sy: vbY + vbH }, view);
      const line = new ps.Path.Line({ from: [a.px, a.py], to: [b.px, b.py] });
      line.strokeColor = '#22262e';
      line.strokeWidth = 0.5;
      grid.addChild(line);
    }
    for (let y = vbY; y <= vbY + vbH; y += state.snapGrid) {
      const a = _svgToCanvas({ sx: vbX, sy: y }, view);
      const b = _svgToCanvas({ sx: vbX + vbW, sy: y }, view);
      const line = new ps.Path.Line({ from: [a.px, a.py], to: [b.px, b.py] });
      line.strokeColor = '#22262e';
      line.strokeWidth = 0.5;
      grid.addChild(line);
    }
    grid.data.role = 'grid';
  }

  // ── symmetric-half axis ──
  if (slot.hint === 'symmetric-half') {
    const a = _svgToCanvas({ sx: 0, sy: vbY }, view);
    const b = _svgToCanvas({ sx: 0, sy: vbY + vbH }, view);
    const axis = new ps.Path.Line({ from: [a.px, a.py], to: [b.px, b.py] });
    axis.strokeColor = '#B56A1D';
    axis.dashArray = [4, 4];
    axis.strokeWidth = 1;
    axis.data.role = 'axis';
  }

  // ── editable path ──
  const path = new ps.Path();
  path.strokeColor = '#B56A1D';
  path.strokeWidth = 1.5;
  path.fillColor = new ps.Color(0.71, 0.42, 0.11, 0.12);
  path.closed = slot.hint === 'closed-path';
  path.data.role = 'profile';
  for (const [sx, sy] of slot.vertices) {
    const c = _svgToCanvas({ sx, sy }, view);
    path.add(new ps.Point(c.px, c.py));
  }

  // ── vertex handles ──
  const handleGroup = new ps.Group();
  handleGroup.data.role = 'handles';
  for (let i = 0; i < path.segments.length; i++) {
    const seg = path.segments[i];
    const handle = new ps.Path.Circle({
      center: seg.point,
      radius: 5,
    });
    handle.fillColor = '#B56A1D';
    handle.strokeColor = '#1b1e24';
    handle.strokeWidth = 1.2;
    handle.data.role = 'vertex';
    handle.data.segmentIndex = i;
    handleGroup.addChild(handle);
  }

  slot.paperPath = path;
  slot.paperHandles = handleGroup;
  slot.cachedView = view;

  ps.view.draw();
}

/* ─── coordinate helpers (canvas px ⇄ SVG-space) ────────────────────── */

function _svgToCanvas(svgPt, view) {
  const m = fitViewBox(view.canvasSize, view.viewBox);
  const [vbX, vbY, vbW, vbH] = view.viewBox;
  return {
    px: m.offsetX + (svgPt.sx - vbX) * m.scale,
    py: m.offsetY + ((vbY + vbH) - svgPt.sy) * m.scale,
  };
}

function _canvasToSvg(canvasPt, view) {
  const m = fitViewBox(view.canvasSize, view.viewBox);
  const [vbX, vbY, vbW, vbH] = view.viewBox;
  return {
    sx: (canvasPt.px - m.offsetX) / m.scale + vbX,
    sy: (vbY + vbH) - (canvasPt.py - m.offsetY) / m.scale,
  };
}

/* ─── UI refresh helpers ────────────────────────────────────────────── */

function _renderSlotTabs() {
  const host = document.getElementById('editorSlotTabs');
  if (!host || !state.element) { if (host) host.innerHTML = ''; return; }
  host.innerHTML = state.element.profileSlots.map(slot => {
    const isActive = state.activeSlot === slot.name;
    const isDirty  = state.slots[slot.name]?.dirty;
    return `<button class="editor-slot-tab ${isActive ? 'active' : ''}" data-slot="${slot.name}">${slot.name}${isDirty ? '<span class="dirty-dot"></span>' : ''}</button>`;
  }).join('');
  for (const btn of host.querySelectorAll('button[data-slot]')) {
    btn.addEventListener('click', () => editorOpenSlot(btn.dataset.slot));
  }
}

function _refreshBreadcrumb() {
  const el = document.getElementById('editorBindingName');
  if (!el) return;
  if (state.binding) {
    el.textContent = `${state.binding.styleSheetId} · ${state.binding.elementId}`;
  } else {
    el.textContent = '— no binding loaded —';
  }
}

function _refreshStatus() {
  const el = document.getElementById('editorStatus');
  if (!el) return;
  const slot = state.slots[state.activeSlot];
  const gridText = state.snapGrid > 0 ? `grid ${state.snapGrid}mm` : 'no grid';
  const vCount = slot?.paperPath?.segments?.length ?? slot?.vertices?.length ?? 0;
  const closed = slot?.hint === 'closed-path' ? 'closed' : 'open';
  el.textContent = `${gridText} · ${vCount} vertices · ${closed}`;
}

function _refreshSaveButton() {
  const btn = document.getElementById('editorSaveBtn');
  if (!btn) return;
  btn.disabled = !hasUnsavedChanges();
}

/* ─── Tool implementations (Paper.js Tool API) ──────────────────────── */

function _setupTools() {
  if (!state.paperScope) return;
  const ps = state.paperScope;

  const selectTool = new ps.Tool();
  let dragSegment = null;

  selectTool.onMouseDown = (event) => {
    if (state.tool !== 'select') return;
    const slot = state.slots[state.activeSlot];
    if (!slot) return;
    const hit = ps.project.hitTest(event.point, { fill: true, tolerance: 6 });
    if (hit && hit.item.data.role === 'vertex') {
      dragSegment = slot.paperPath.segments[hit.item.data.segmentIndex];
      // Visually highlight the selected vertex.
      for (const h of slot.paperHandles.children) {
        h.fillColor = '#B56A1D';
      }
      slot.paperHandles.children[hit.item.data.segmentIndex].fillColor = '#ff8956';
    } else {
      dragSegment = null;
      for (const h of slot.paperHandles.children) h.fillColor = '#B56A1D';
    }
  };

  selectTool.onMouseDrag = (event) => {
    if (state.tool !== 'select' || !dragSegment) return;
    const slot = state.slots[state.activeSlot];
    if (!slot) return;
    // Canvas mouse → SVG-space → snap → hint enforcement → back to canvas.
    const sv = _canvasToSvg({ px: event.point.x, py: event.point.y }, slot.cachedView);
    const sx = state.snapGrid > 0 ? snap(sv.sx, state.snapGrid) : sv.sx;
    const sy = state.snapGrid > 0 ? snap(sv.sy, state.snapGrid) : sv.sy;
    const clamped = applyHint([[sx, sy]], slot.hint)[0];
    const c = _svgToCanvas({ sx: clamped[0], sy: clamped[1] }, slot.cachedView);
    dragSegment.point = new ps.Point(c.px, c.py);
    const idx = slot.paperPath.segments.indexOf(dragSegment);
    if (idx >= 0 && slot.paperHandles) {
      slot.paperHandles.children[idx].position = new ps.Point(c.px, c.py);
    }
    _markDirty();
    _refreshStatus();
    _scheduleSlotSync();
  };

  selectTool.onMouseUp = () => { dragSegment = null; };

  selectTool.onKeyDown = (event) => {
    if (state.tool !== 'select') return;
    if (event.key === 'delete' || event.key === 'backspace') {
      const slot = state.slots[state.activeSlot];
      if (!slot) return;
      // Find selected vertex handles (highlighted in orange-bright via fillColor).
      const handles = slot.paperHandles.children;
      const selectedIndices = [];
      for (let i = 0; i < handles.length; i++) {
        const c = handles[i].fillColor;
        if (c && c.red > 0.99 && c.green > 0.5) selectedIndices.push(i);
      }
      if (selectedIndices.length === 0) return;
      // Remove in reverse order so indices stay valid.
      selectedIndices.sort((a, b) => b - a);
      for (const idx of selectedIndices) {
        slot.paperPath.removeSegment(idx);
        slot.paperHandles.children[idx].remove();
      }
      // Re-tag handle indices.
      for (let i = 0; i < slot.paperHandles.children.length; i++) {
        slot.paperHandles.children[i].data.segmentIndex = i;
      }
      _markDirty();
      _refreshStatus();
      _scheduleSlotSync();
    }
  };

  const penTool = new ps.Tool();
  penTool.onMouseDown = (event) => {
    if (state.tool !== 'pen') return;
    const slot = state.slots[state.activeSlot];
    if (!slot) return;
    let { sx, sy } = _canvasToSvg({ px: event.point.x, py: event.point.y }, slot.cachedView);
    if (state.snapGrid > 0) {
      sx = snap(sx, state.snapGrid);
      sy = snap(sy, state.snapGrid);
    }
    const clamped = applyHint([[sx, sy]], slot.hint)[0];
    const c = _svgToCanvas({ sx: clamped[0], sy: clamped[1] }, slot.cachedView);
    slot.paperPath.add(new ps.Point(c.px, c.py));
    const h = new ps.Path.Circle({ center: [c.px, c.py], radius: 5 });
    h.fillColor = '#B56A1D';
    h.strokeColor = '#1b1e24';
    h.strokeWidth = 1.2;
    h.data.role = 'vertex';
    h.data.segmentIndex = slot.paperPath.segments.length - 1;
    slot.paperHandles.addChild(h);
    _markDirty();
    _refreshStatus();
    _scheduleSlotSync();
  };

  const panTool = new ps.Tool();
  panTool.onMouseDrag = (event) => {
    if (state.tool !== 'pan') return;
    ps.view.translate(event.delta);
  };

  // Wheel zoom (Paper.js Tool API doesn't natively expose scroll).
  const canvas = document.getElementById('editorCanvas');
  if (canvas) {
    canvas.addEventListener('wheel', (e) => {
      if (!state.active) return;
      e.preventDefault();
      const oldZoom = ps.view.zoom;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      ps.view.zoom = Math.max(0.2, Math.min(10, oldZoom * factor));
    }, { passive: false });
  }

  // Default-activate the select tool.
  selectTool.activate();
}

/* ─── dirty tracking + slot sync ──────────────────────────────────────── */

function _markDirty() {
  const slot = state.slots[state.activeSlot];
  if (!slot) return;
  if (!slot.dirty) {
    slot.dirty = true;
    _refreshSaveButton();
    _renderSlotTabs();
  }
}

let _previewQueued = false;
function _scheduleSlotSync() {
  // Sync the Paper.js path's current segment positions back to slot.vertices,
  // then queue a preview refresh.
  const slot = state.slots[state.activeSlot];
  if (!slot || !slot.paperPath) return;
  slot.vertices = slot.paperPath.segments.map((seg) => {
    const sv = _canvasToSvg({ px: seg.point.x, py: seg.point.y }, slot.cachedView);
    return [sv.sx, sv.sy];
  });
  if (!_previewQueued) {
    _previewQueued = true;
    requestAnimationFrame(() => {
      _previewQueued = false;
      _refreshPreview();
    });
  }
}

function _refreshPreview() {
  // Implemented in Batch 5 (Task 10).
}
