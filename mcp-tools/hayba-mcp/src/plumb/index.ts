// PLUMB-style constraint subsystem — public surface.
//
// A quantified, directional validator + a tiny CLOSED constraint language bound
// to assets/tags, plus baked physical profiles. See contracts.ts for the seam,
// primitives.ts for the (whole) grammar, and project_mcp_ux_validation_overhaul
// memory for the design rationale.

export * from './contracts.js';
export { PRIMITIVES, primitivesById, polygonMargin, resolveHard } from './primitives.js';
export type { Primitive, PrimitiveContext, PrimitiveOutcome } from './primitives.js';
export { evaluate, assembleVerdict, bindingMatches, evalConstraint } from './evaluate.js';
export type { EvaluateOptions } from './evaluate.js';
export {
  loadConstraints, upsertConstraint, removeConstraint, constraintsFor,
  validateConstraint, getConstraintsPath, setConstraintsPath,
} from './constraint-store.js';
export type { ValidationError } from './constraint-store.js';
export {
  loadProfiles, getProfile, profileMap, putProfile, annotateProfile, removeProfile,
  getProfilesPath, setProfilesPath, addMask, getMask, removeMask,
} from './profile-store.js';
export { bakeProfile } from './bake.js';
export type { UeBoundsInput } from './bake.js';
