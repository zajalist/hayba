/**
 * Hayba Architecture Atlas — SVG vertex editor (browser module).
 *
 * Public API (called by index.html):
 *   - openEditor(bindingKey, opts): void
 *   - closeEditor(): void
 *   - hasUnsavedChanges(): boolean
 *   - editorOpenSlot(slotName): void
 *
 * State lives in this module's `state` object. Paper.js is loaded via importmap.
 * Subsequent batches fill in: load binding (Batch 3), tools (Batch 4),
 * live 3D preview + save (Batch 5).
 */

import * as paper from 'paper';
import {
  verticesToSvgPath, parsePathD, applyHint, sanitizeVertices,
  canvasToSvgSpace, svgToCanvasSpace, fitViewBox, snap,
  loadElementCatalog, registerBinding, emitElementMesh,
} from '../dist/index.js';

/* ─── module-local state ──────────────────────────────────────────────── */

const state = {
  active: false,
  bindingKey: null,           // 'medieval-european-gothic::column' or null
  binding: null,              // full ElementBinding object
  element: null,              // Element definition (profileSlots, paramSchema)
  activeSlot: null,           // 'shaft' | 'base' | ...
  slots: {},                  // { [slotName]: SlotState }
  tool: 'select',             // 'select' | 'pen' | 'pan' | 'zoom'
  snapGrid: 5,                // mm
  paperScope: null,           // paper.PaperScope when active
  saveCallback: null,
  bindingsRef: null,          // reference to atlas-wide bindings dict
  kernelRef: null,            // reference to loaded kernel module
};

/* ─── public API ─────────────────────────────────────────────────────── */

export function openEditor(bindingKey, opts) {
  // Implemented in Batch 3 (Task 7).
  console.warn('openEditor: not yet implemented (Task 7)');
  state.bindingKey = bindingKey;
  state.saveCallback = opts?.onSave ?? null;
  state.bindingsRef = opts?.bindingsRef ?? null;
  state.kernelRef = opts?.kernelRef ?? null;
  state.active = true;
}

export function closeEditor() {
  // Full disposal in Batch 5 (Task 10/11). For now, just reset state.
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
  // Implemented in Batch 3.
  state.activeSlot = slotName;
}

/* ─── internal helpers (filled in subsequent batches) ────────────────── */
// (intentionally empty for now)
