// Validator public surface.

export { RULES, rulesById, rulesForTool, attachEvaluator } from './rules.js';
export type { ValidatorRule, ValidatorFinding, ValidatorContext, ValidatorSeverity, ValidatorTrigger } from './rules.js';
export { runAfterTool, runManual, emitDirectFinding } from './runner.js';
export { appendFinding, listFindings, markResolved, clearHistory, replaceFindingsWithPrefix, getHistoryPath, setHistoryPath } from './history.js';
export { isRuleDisabled, setRuleDisabled, listDisabledRules, setConfigPath } from './config.js';
export { installToolHooks, isSelfSocketScript, danglingLifetimeRegistration } from './tool-hooks.js';
export { attachFindingsToResponse, attachFindingsToValue } from './response.js';
