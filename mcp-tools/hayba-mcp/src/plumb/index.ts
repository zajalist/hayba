// PLUMB-style constraint subsystem — public surface.
//
// A quantified, directional validator + a tiny CLOSED constraint language bound
// to assets/tags, plus baked physical profiles. See contracts.ts for the seam,
// primitives.ts for the (whole) grammar, and project_mcp_ux_validation_overhaul
// memory for the design rationale.

export * from './contracts.js';
export type { Mask } from './contracts.js';
export { PRIMITIVES, primitivesById, polygonMargin, resolveHard } from './primitives.js';
export type { Primitive, PrimitiveContext, PrimitiveOutcome } from './primitives.js';
export { evaluate, evaluatePerInstance, assembleVerdict, bindingMatches, evalConstraint } from './evaluate.js';
export type { EvaluateOptions, InstanceVerdict } from './evaluate.js';
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
export { compileGraph, constraintsToGraph } from './graph.js';
export type { ConstraintGraph, GraphNode, GraphEdge } from './graph.js';
export {
  loadLessons, getLesson, upsertLesson, removeLesson, validateLesson,
  getLessonsPath, setLessonsPath,
} from './lesson-store.js';
export type { Lesson, LessonValidationError } from './lesson-store.js';
export { enqueueStudyRequest, takeStudyRequests, getStudyRequestsPath, setStudyRequestsPath } from './study-requests.js';
export type { StudyRequest } from './study-requests.js';
export {
  getGrammarPath, setGrammarPath, putProduction, getProduction, listProductions,
  removeProduction, productionMap, validateProduction,
} from './grammar-store.js';
export { matchProductions, expandGrammar } from './grammar.js';
export type { PlacedItem, PlacementPlan, GuardFn } from './grammar.js';
