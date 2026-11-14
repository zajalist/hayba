import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface AppVault {
  provider: string;
  model: string;
  baseURL: string;
  keys: Record<string, string>;
}

const EMPTY: AppVault = { provider: 'anthropic', model: 'claude-opus-4-8', baseURL: '', keys: {} };

export function defaultVaultPath(): string {
  if (process.env.HAYBA_APP_VAULT) return process.env.HAYBA_APP_VAULT;
  const root =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
      : process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(root, 'HaybaMCP', 'app-vault.json');
}

export function loadVault(path = defaultVaultPath()): AppVault {
  if (!existsSync(path)) return { ...EMPTY, keys: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<AppVault>;
    return {
      provider: typeof parsed.provider === 'string' ? parsed.provider : EMPTY.provider,
      model: typeof parsed.model === 'string' ? parsed.model : EMPTY.model,
      baseURL: typeof parsed.baseURL === 'string' ? parsed.baseURL : '',
      keys: parsed.keys && typeof parsed.keys === 'object' ? { ...parsed.keys } : {},
    };
  } catch {
    return { ...EMPTY, keys: {} };
  }
}

export function saveVault(vault: AppVault, path = defaultVaultPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = JSON.stringify({
    provider: vault.provider,
    model: vault.model,
    baseURL: vault.baseURL,
    keys: vault.keys,
  });
  writeFileSync(path, body, { encoding: 'utf8', mode: 0o600 });
}

export function last4(value: string | undefined): string {
  if (!value) return '';
  return value.length <= 4 ? value : value.slice(-4);
}
