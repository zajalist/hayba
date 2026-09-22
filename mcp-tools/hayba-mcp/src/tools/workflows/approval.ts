import type { WorkflowResult, WorkflowStageResult } from './contracts.js';
import { stageResult } from './contracts.js';

/** Keep the native approval signal inside the common workflow envelope. */
export function approvalRequired(stage: string): WorkflowStageResult {
  return stageResult(stage, 'pending', {
    code: 'plan_mode_required', summary: 'Plan Mode requires approval before this mutation can run',
    remediation: [{ code: 'approve_plan', label: 'Review and approve the requested mutation before resuming' }],
  });
}

export function workflowNeedsApproval(result: Pick<WorkflowResult, 'stages'>): boolean {
  return result.stages.some((stage) => stage.code === 'plan_mode_required' && stage.status === 'pending');
}
