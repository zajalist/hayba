import { executeCommand } from '../tool-executor.js';

/**
 * Read a UHaybaMCPDeveloperSettings field via the UE bridge. The C++ side
 * allowlists which keys are exposed (see HaybaMCPCommandHandler.cpp).
 *
 * Returns the configured value, or `null` if:
 *   - the field is empty in the settings panel, or
 *   - UE is not reachable (e.g. editor isn't running), or
 *   - the UE plugin is older than the get_setting handler.
 *
 * Callers should fall back to an env var when this returns null, so the
 * tooling still works headless or before the user has filled the field.
 */
export async function getSetting(key: string): Promise<string | null> {
  try {
    const res = (await executeCommand('get_setting', { key })) as { value?: unknown; set?: unknown };
    if (!res || typeof res !== 'object') return null;
    if (res.set === true && typeof res.value === 'string' && res.value.length > 0) {
      return res.value;
    }
    return null;
  } catch {
    return null;
  }
}

/** Read a token from the UE settings panel, falling back to an env var. */
export async function getTokenWithEnvFallback(settingKey: string, envVar: string): Promise<string | null> {
  const fromUe = await getSetting(settingKey);
  if (fromUe) return fromUe;
  const fromEnv = process.env[envVar];
  return fromEnv && fromEnv.length > 0 ? fromEnv : null;
}
