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

// AI binding pipeline
export type {
  BindingRequest, RawBindingResponse, ParsedBindingDraft,
  AIProviderName, AIProvider,
  GenerateBindingResult, GenerateBindingError,
} from './ai/types.js';
export { buildPrompt, hashPrompt } from './ai/prompt-builder.js';
export { parseResponse } from './ai/response-parser.js';
export { MockProvider } from './ai/provider-mock.js';
export { AnthropicProvider } from './ai/provider-anthropic.js';
export type { AnthropicProviderOptions } from './ai/provider-anthropic.js';
export { OpenAICompatibleProvider, OPENAI_COMPAT_PRESETS } from './ai/provider-openai-compat.js';
export type { OpenAICompatibleProviderOptions } from './ai/provider-openai-compat.js';
export { generateBinding } from './ai/generate-binding.js';
export type { GenerateBindingArgs } from './ai/generate-binding.js';
export { registerBinding } from './element-registry.js';

// SVG editor utilities (pure, browser-safe)
export type { Vec2 } from './editor/svg-serialize.js';
export {
  verticesToSvgPath, parsePathD, applyHint, sanitizeVertices,
} from './editor/svg-serialize.js';
export type { ViewState, CanvasPt, SvgPt } from './editor/coord-map.js';
export {
  canvasToSvgSpace, svgToCanvasSpace, fitViewBox, snap,
} from './editor/coord-map.js';

// Culture system (v2)
export * from './culture/index.js';
