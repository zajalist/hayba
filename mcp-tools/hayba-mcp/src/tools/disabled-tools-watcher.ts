// Reads (and live-watches) Saved/HaybaMCP/disabled-tools.json so the MCP
// server can filter list_tool_categories / get_tool_signature and reject
// disabled tool calls with a clear `tool_disabled` error.
//
// File shape:
//   { "disabled": ["actor_spawn", "scene_validate_physics", ...] }
//
// The UE plugin's FHaybaMCPSettings::Save() writes this file every time the
// user toggles something in the MCP panel.

import { readFileSync, watch } from 'node:fs';
import { resolve } from 'node:path';

function disabledToolsPath(): string {
  const override = process.env.HAYBA_DISABLED_TOOLS_PATH;
  if (override) return override;
  // The Node MCP server is started from the plugin's ThirdParty/mcp_server/dist,
  // so the project Saved/ sits a few levels above. Allow override via env var
  // when running from an arbitrary location (workspace dist).
  return resolve(process.cwd(), 'Saved/HaybaMCP/disabled-tools.json');
}

let cached: Set<string> = new Set();
let watcherInstalled = false;

function reload(): void {
  try {
    const path = disabledToolsPath();
    const raw = readFileSync(path, 'utf-8');
    const json = JSON.parse(raw) as { disabled?: string[] };
    cached = new Set(json.disabled ?? []);
  } catch {
    // File missing or malformed — treat as "nothing disabled".
    cached = new Set();
  }
}

function ensureWatcher(): void {
  if (watcherInstalled) return;
  watcherInstalled = true;
  reload();
  try {
    const path = disabledToolsPath();
    watch(path, { persistent: false }, () => reload());
  } catch {
    // File doesn't exist yet — the user hasn't opened the MCP tab. We'll
    // pick it up on the next reload() call when it does.
  }
}

export function isToolDisabled(toolName: string): boolean {
  ensureWatcher();
  return cached.has(toolName);
}

export function listDisabledTools(): string[] {
  ensureWatcher();
  return Array.from(cached).sort();
}
