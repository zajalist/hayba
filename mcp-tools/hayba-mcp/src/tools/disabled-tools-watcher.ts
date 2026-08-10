// Reads (and live-watches) Saved/HaybaMCP/disabled-tools.json so the MCP
// server can filter list_tool_categories / get_tool_signature and reject
// disabled tool calls with a clear `tool_disabled` error.
//
// File shape:
//   { "disabled": ["actor_spawn", "scene_validate_physics", ...] }
//
// The UE plugin's FHaybaMCPSettings::Save() writes this file every time the
// user toggles something in the MCP panel.

import { readFileSync, watch, type FSWatcher } from 'node:fs';
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
export type AdvisoryVerbosity = 'errors_only' | 'errors_and_warnings' | 'errors_warnings_and_tips';

const DEFAULT_ADVISORY_VERBOSITY: AdvisoryVerbosity = 'errors_and_warnings';
let cachedAdvisoryVerbosity: AdvisoryVerbosity = DEFAULT_ADVISORY_VERBOSITY;
let watcherInstalled = false;
let watcher: FSWatcher | null = null;

function parseAdvisoryVerbosity(value: unknown): AdvisoryVerbosity {
  return value === 'errors_only' || value === 'errors_and_warnings' || value === 'errors_warnings_and_tips'
    ? value
    : DEFAULT_ADVISORY_VERBOSITY;
}

function reload(): void {
  try {
    const path = disabledToolsPath();
    const raw = readFileSync(path, 'utf-8');
    const json = JSON.parse(raw) as { disabled?: string[]; advisory_verbosity?: unknown };
    cached = new Set(json.disabled ?? []);
    cachedAdvisoryVerbosity = parseAdvisoryVerbosity(json.advisory_verbosity);
  } catch {
    // File missing or malformed — treat as "nothing disabled".
    cached = new Set();
    cachedAdvisoryVerbosity = DEFAULT_ADVISORY_VERBOSITY;
  }
}

function ensureWatcher(): void {
  if (watcherInstalled) return;
  watcherInstalled = true;
  reload();
  try {
    const path = disabledToolsPath();
    watcher = watch(path, { persistent: false }, () => reload());
  } catch {
    // File doesn't exist yet — retry installation on the next query so a file
    // created after Node startup is not ignored for the whole process lifetime.
    watcherInstalled = false;
    watcher = null;
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

/** User-selected optional-guidance level mirrored by the UE plugin settings. */
export function getAdvisoryVerbosity(): AdvisoryVerbosity {
  ensureWatcher();
  return cachedAdvisoryVerbosity;
}

/** Reset internal cache — used in tests. Not part of the public API. */
export function __resetDisabledToolsCache(): void {
  watcher?.close();
  watcher = null;
  cached = new Set();
  cachedAdvisoryVerbosity = DEFAULT_ADVISORY_VERBOSITY;
  watcherInstalled = false;
}
