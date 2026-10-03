import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type ToolRoutingMode = 'deferred' | 'full';
export interface HaybaSettings {
  toolRouting: ToolRoutingMode;
  alwaysLoadPacks: string[];
  /** External MCP route advisor. Off by default; brain requires signed-in Pro. */
  externalRouteAdvice: 'off' | 'local' | 'brain';
}

const DEFAULT: HaybaSettings = { toolRouting: 'deferred', alwaysLoadPacks: [], externalRouteAdvice: 'off' };

function settingsPath(): string {
  return process.env.HAYBA_SETTINGS_PATH
    ?? resolve(process.cwd(), 'Saved/HaybaMCP/settings.json');
}

let cached: HaybaSettings | null = null;

export function readSettings(): HaybaSettings {
  if (cached) return cached;
  try {
    const raw = readFileSync(settingsPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<HaybaSettings>;
    cached = {
      toolRouting: parsed.toolRouting === 'full' ? 'full' : 'deferred',
      alwaysLoadPacks: Array.isArray(parsed.alwaysLoadPacks) ? parsed.alwaysLoadPacks : [],
      externalRouteAdvice: parsed.externalRouteAdvice === 'local' || parsed.externalRouteAdvice === 'brain'
        ? parsed.externalRouteAdvice : 'off',
    };
  } catch {
    cached = DEFAULT;
  }
  return cached;
}

export function __resetSettingsCache(): void { cached = null; }
