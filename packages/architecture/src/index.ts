export type {
  FeatureBundle, RoofType, PrimaryMaterial,
  FootprintKind, FootprintShape,
  Typology, StyleSheet, StyleGuide,
} from './schema.js';

export {
  ROOF_TYPES, PRIMARY_MATERIALS, FOOTPRINT_KINDS,
} from './schema.js';

export type { ValidationError } from './validate.js';
export {
  ArchitectureSchemaError,
  validateFootprintShape, validateTypology, validateStyleSheet,
  validateStyleGuide, validateStyleGuideRefs,
  isFootprintShape, isTypology, isStyleSheet, isStyleGuide,
} from './validate.js';

export type { Registry } from './registry.js';
export {
  ArchitectureRegistryError,
  loadRegistry, getTypology,
} from './registry.js';

export type {
  GetTypologyResult, ValidateStyleGuideResult,
} from './mcp.js';
export {
  getTypologyTool, validateStyleGuideTool,
} from './mcp.js';

// Element catalog + kernel surface
export type {
  ProfileHint, ProfileSlot, ParamSlot, ParamSlotKind,
  ElementCategory, ElementGraphRef, Element,
  ProvenanceSource, BindingProvenance, ElementBinding,
} from './schema.js';
export { validateElement, validateElementBinding, isElement } from './validate.js';
export type { ElementCatalog, BindingCatalog, EmitResult, EmitError } from './element-registry.js';
export {
  loadElementCatalog, loadBinding, emitElementMesh,
} from './element-registry.js';

export { registerBinding } from './element-registry.js';

// Culture system (v2)
export * from './culture/index.js';
