import { z } from 'zod';
import { join } from 'node:path';
import { executeCommand } from './tool-executor.js';
import { runAfterTool } from '../validator/runner.js';
import { attachFindingsToValue } from '../validator/response.js';
import type { ValidatorFinding } from '../validator/rules.js';

const schema = z.object({
  assetPath: z.string().min(1).describe('Full UE asset path to the PCGGraph to execute')
});

export type ExecutePcgGraphParams = z.infer<typeof schema>;

export interface ExecutePcgGraphResult extends Record<string, unknown> {
  validator?: { findings: ValidatorFinding[] };
}

export async function executePcgGraph(params: ExecutePcgGraphParams): Promise<ExecutePcgGraphResult> {
  const { assetPath } = schema.parse(params);
  let result: Record<string, unknown>;
  try {
    result = await executeCommand('execute_graph', { assetPath });
  } catch (e) {
    // Still emit findings for the error-text-based rules.
    result = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  // Lazy-import the TCP client to avoid pulling network deps into pure-TS test
  // setups that import this module without an active UE.
  let ue = null;
  try {
    const tcpMod = await import('../tcp-client.js');
    ue = await tcpMod.ensureConnected().catch(() => null);
  } catch {
    ue = null;
  }

  const findings = await runAfterTool({
    toolName: 'hayba_execute_pcg_graph',
    toolArgs: { assetPath },
    toolResult: result,
    ue,
    scratchDir: join(process.cwd(), '.scratch'),
  });
  return attachFindingsToValue(result, findings);
}
