import { executeCommand } from './tool-executor.js';

export async function checkUeStatus() {
  try {
    const data = await executeCommand<Record<string, unknown>>('ping', {}, { timeout: 5000 });
    return { connected: true, ...data };
  } catch (err) {
    return { connected: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}
