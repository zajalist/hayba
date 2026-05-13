import { validateElement, validateElementBinding, type ValidationError } from './validate.js';
import type { Element, ElementBinding } from './schema.js';
import { ELEMENT_GENERATORS } from './kernel/elements/index.js';
import { emitGLB } from './kernel/glb-emit.js';

import columnFile from './data/elements/column.json' with { type: 'json' };
import gothicColumnFile from './bindings/medieval-european-gothic/column.json' with { type: 'json' };

const RAW_ELEMENTS: unknown[] = [columnFile];

interface BindingRecord {
  styleSheetId: string;
  raw: unknown;
}
const RAW_BINDINGS: BindingRecord[] = [
  { styleSheetId: 'medieval-european-gothic', raw: gothicColumnFile },
];

export interface ElementCatalog {
  readonly elementsById: ReadonlyMap<string, Element>;
}

export interface BindingCatalog {
  readonly byKey: ReadonlyMap<string, ElementBinding>;
}

let CAT_ELEMENTS: ElementCatalog | null = null;
let CAT_BINDINGS: BindingCatalog | null = null;

export function loadElementCatalog(): ElementCatalog {
  if (CAT_ELEMENTS) return CAT_ELEMENTS;
  const errors: ValidationError[] = [];
  const elementsById = new Map<string, Element>();
  RAW_ELEMENTS.forEach((e, i) => {
    const errs = validateElement(e, `/elements/${i}`);
    if (errs.length === 0) {
      const typed = e as Element;
      if (elementsById.has(typed.id)) {
        errors.push({ path: `/elements/${i}/id`, message: `duplicate element id ${typed.id}` });
      } else {
        elementsById.set(typed.id, typed);
      }
    } else {
      errors.push(...errs);
    }
  });
  if (errors.length > 0) {
    throw new Error(`@hayba/architecture: element catalog load failed: ${JSON.stringify(errors, null, 2)}`);
  }
  CAT_ELEMENTS = { elementsById };
  return CAT_ELEMENTS;
}

function parseBindingSeed(raw: unknown): bigint {
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'string') return BigInt(raw);
  if (typeof raw === 'number') return BigInt(raw);
  throw new Error(`seed must be bigint, hex string, or number; got ${typeof raw}`);
}

function loadBindingCatalog(): BindingCatalog {
  if (CAT_BINDINGS) return CAT_BINDINGS;
  const elements = loadElementCatalog();
  const errors: ValidationError[] = [];
  const byKey = new Map<string, ElementBinding>();

  RAW_BINDINGS.forEach(({ styleSheetId, raw }, i) => {
    if (typeof raw !== 'object' || raw === null) {
      errors.push({ path: `/bindings/${i}`, message: 'expected an object' });
      return;
    }
    const rawWithSeed = { ...(raw as object), seed: parseBindingSeed((raw as { seed: unknown }).seed) };
    const elementId = (rawWithSeed as { elementId?: string }).elementId;
    if (!elementId || !elements.elementsById.has(elementId)) {
      errors.push({ path: `/bindings/${i}/elementId`, message: `unknown element ${JSON.stringify(elementId)}` });
      return;
    }
    const element = elements.elementsById.get(elementId)!;
    const bindingErrs = validateElementBinding(rawWithSeed, element, `/bindings/${i}`);
    if (bindingErrs.length > 0) {
      errors.push(...bindingErrs);
      return;
    }
    const typed = rawWithSeed as ElementBinding;
    const key = `${styleSheetId}::${elementId}`;
    if (byKey.has(key)) {
      errors.push({ path: `/bindings/${i}`, message: `duplicate binding for ${key}` });
      return;
    }
    byKey.set(key, typed);
  });

  if (errors.length > 0) {
    throw new Error(`@hayba/architecture: binding catalog load failed: ${JSON.stringify(errors, null, 2)}`);
  }
  CAT_BINDINGS = { byKey };
  return CAT_BINDINGS;
}

export function loadBinding(styleSheetId: string, elementId: string): ElementBinding | null {
  return loadBindingCatalog().byKey.get(`${styleSheetId}::${elementId}`) ?? null;
}

export interface EmitResult {
  ok: true;
  glb: ArrayBuffer;
  stats: { vertices: number; triangles: number; sizeBytes: number };
}
export interface EmitError {
  ok: false;
  error: 'not_found' | 'kernel_error';
  message: string;
}

export function emitElementMesh(styleSheetId: string, elementId: string): EmitResult | EmitError {
  const binding = loadBinding(styleSheetId, elementId);
  if (!binding) {
    return { ok: false, error: 'not_found', message: `no binding for ${styleSheetId}::${elementId}` };
  }
  const gen = ELEMENT_GENERATORS[elementId];
  if (!gen) {
    return { ok: false, error: 'not_found', message: `no generator registered for element ${elementId}` };
  }
  try {
    const mesh = gen(binding);
    const glb = emitGLB(mesh);
    return {
      ok: true,
      glb,
      stats: {
        vertices: mesh.positions.length / 3,
        triangles: mesh.indices.length / 3,
        sizeBytes: glb.byteLength,
      },
    };
  } catch (e: unknown) {
    return { ok: false, error: 'kernel_error', message: e instanceof Error ? e.message : String(e) };
  }
}

export function _resetCacheForTests(): void {
  CAT_ELEMENTS = null;
  CAT_BINDINGS = null;
}
