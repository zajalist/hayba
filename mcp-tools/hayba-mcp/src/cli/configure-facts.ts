// Locating and writing client config files. Everything impure for `configure`
// lives here; the judgement is in configure.ts and is tested without a disk.

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { ClientId, ClientSpec } from './configure.js';

/**
 * Where Claude Desktop keeps its config.
 *
 * The Windows path is VERIFIED on a real install
 * (`%APPDATA%/Claude/claude_desktop_config.json`, holding `mcpServers`
 * alongside unrelated keys like `preferences`). The macOS and Linux paths are
 * from documentation, not from a machine I could check — if a report comes in
 * that `configure` cannot find Claude Desktop on a Mac, this constant is the
 * first thing to doubt.
 */
export function claudeDesktopConfigPath(): string {
  const home = homedir();
  switch (platform()) {
    case 'win32':
      return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'),
                  'Claude', 'claude_desktop_config.json');
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Claude',
                  'claude_desktop_config.json');
    default:
      return join(home, '.config', 'Claude', 'claude_desktop_config.json');
  }
}

/** Absolute config path for a client, given the project root to configure. */
export function configPathFor(spec: ClientSpec, projectRoot: string): string {
  if (spec.projectRelativePath === null) return claudeDesktopConfigPath();
  return join(resolve(projectRoot), spec.projectRelativePath);
}

/**
 * Which clients look present on this machine.
 *
 * Deliberately generous: a project-scoped client counts as "present" if its
 * directory exists OR its config already does. We would rather offer to
 * configure something the user does not have than silently omit something they
 * do -- an unwanted `.cursor/mcp.json` is a file to delete, while a missing one
 * is an onboarding failure with no error message.
 */
export function detectClients(projectRoot: string): ClientId[] {
  const root = resolve(projectRoot);
  const found: ClientId[] = [];

  if (existsSync(join(root, '.mcp.json')) || existsSync(join(root, '.claude'))) {
    found.push('claude-code');
  }
  if (existsSync(join(root, '.cursor'))) found.push('cursor');
  if (existsSync(join(root, '.vscode'))) found.push('vscode');
  if (existsSync(dirname(claudeDesktopConfigPath()))) found.push('claude-desktop');

  return found;
}

export function readConfigText(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    // Unreadable is not the same as absent: returning null here would let the
    // caller create a fresh config on top of one it merely could not open.
    throw new Error(`cannot read ${path} — check permissions`);
  }
}

/**
 * Write the new config, keeping a copy of what was there.
 *
 * The backup is not optional. This command edits a file the user did not ask
 * us to touch on their behalf before today, and "it used to work" needs to be
 * recoverable without a support thread.
 */
export function writeConfigText(path: string, text: string): { backedUpTo: string | null } {
  mkdirSync(dirname(path), { recursive: true });

  let backedUpTo: string | null = null;
  if (existsSync(path)) {
    backedUpTo = `${path}.hayba-backup`;
    copyFileSync(path, backedUpTo);
  }

  writeFileSync(path, text, 'utf8');
  return { backedUpTo };
}

/**
 * The command + args a client should launch.
 *
 * Absolute, because a client spawns the server from its own working directory,
 * not the project's. This is the value users get wrong by hand, and getting it
 * wrong produces no error -- just a client that lists no tools.
 */
export function serverEntryFor(serverJsPath: string): { command: string; args: string[] } {
  return { command: process.execPath, args: [resolve(serverJsPath)] };
}
