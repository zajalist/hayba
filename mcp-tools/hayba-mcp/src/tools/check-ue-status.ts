import { ensureConnected } from '../tcp-client.js';

export async function checkUeStatus() {
  try {
    const client = await ensureConnected();
    const response = await client.send('ping', {}, 5000);
    if (response.ok && response.data) {
      return { connected: true, ...response.data };
    }
    return { connected: false, error: response.error };
  } catch (err) {
    return { connected: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}
