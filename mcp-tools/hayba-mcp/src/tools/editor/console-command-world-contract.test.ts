/**
 * A production project, 2026-11-12: lanes ran the game's own console commands (weather, tools, debug) through
 * editor_run_console_command while PIE was running, and they found no game. The handler always passed the EDITOR world
 * to GEngine->Exec, so world-aware commands (FAutoConsoleCommandWithWorld*) looked for the game mode, player and
 * subsystems in a world that has none. The editor's own console sends commands to GEditor->PlayWorld while PIE runs
 * (FConsoleCommandExecutor::ExecInternal). Pins the fix: world = auto (default) | pie | editor; auto is the PIE world
 * while PIE runs, else the editor world; pie with no PIE running is refused before anything executes; the reply names
 * the world (and PIE instance) the command ran in.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { setDefaultSender, type Sender } from '../tool-executor.js';
import { STATIC_TOOL_CATALOGUE } from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const editor = readFileSync(
  join(
    here,
    '..',
    '..',
    '..',
    '..',
    '..',
    'unreal',
    'HaybaMCPToolkit',
    'Source',
    'HaybaMCPToolkit',
    'Private',
    'handlers',
    'HaybaMCPEditorHandler.cpp',
  ),
  'utf8',
).replace(/\r\n/g, '\n');
const start = editor.indexOf('FHaybaHandlerResult FHaybaMCPEditorHandler::RunConsoleCommand(');
const body = editor.slice(start, editor.indexOf('\n}\n', start));
const exec = body.indexOf('GEngine->Exec(');
const sidecar = JSON.parse(readFileSync(join(here, '..', '..', 'legacy-commands', 'sidecar.json'), 'utf8')) as {
  commands: Record<string, { params: Array<{ name: string; type: string; required: boolean; default?: unknown }> }>;
};

describe('editor_run_console_command world target', () => {
  it('no longer sends every command to the editor world', () => {
    expect(body).not.toMatch(
      /UWorld\* World = GEditor \? GEditor->GetEditorWorldContext\(\)\.World\(\) : nullptr;\s*GEngine->Exec/,
    );
    expect(body).toContain('GEngine->Exec(World, *Command, *GLog);');
  });

  it('defaults to auto and refuses an unknown world before executing', () => {
    expect(body).toContain('FString Target = TEXT("auto");');
    expect(body).toContain('P->TryGetStringField(TEXT("world"), Target);');
    expect(body.indexOf('world must be auto, pie or editor. Nothing was executed.')).toBeGreaterThan(-1);
    expect(body.indexOf('world must be auto, pie or editor')).toBeLessThan(exec);
  });

  it('auto and pie take the PIE world; editor and auto-without-PIE take the editor world', () => {
    expect(body).toContain('Target != TEXT("editor") ? GEditor->PlayWorld.Get() : nullptr');
    expect(body).toContain('if (!World && GEditor) World = GEditor->GetEditorWorldContext().World();');
  });

  it('pie with no PIE running is refused before executing', () => {
    const refusal = body.indexOf('no Play-In-Editor session is running. Nothing was executed.');
    expect(refusal).toBeGreaterThan(-1);
    expect(body).toContain('if (!World && Target == TEXT("pie"))');
    expect(refusal).toBeLessThan(exec);
  });

  it('reports the world the command ran in, and the PIE instance', () => {
    expect(body).toContain('Result->SetStringField(TEXT("world"), bPie ? TEXT("pie") : TEXT("editor"));');
    expect(body).toContain('Result->SetNumberField(TEXT("pie_instance"), Context->PIEInstance);');
  });

  it('declares world in the sidecar, so the generated schema keeps it', () => {
    const world = sidecar.commands['editor_run_console_command'].params.find((p) => p.name === 'world');
    expect(world).toMatchObject({ type: 'string', required: false, default: 'auto' });
  });
});

describe('the MCP tool', () => {
  const calls: Array<{ cmd: string; params: Record<string, unknown> }> = [];
  beforeEach(() => {
    calls.length = 0;
    setDefaultSender((async (cmd: string, params: Record<string, unknown>) => {
      calls.push({ cmd, params });
      return { id: 'inmem', ok: true, data: { executed: true } };
    }) as Sender);
  });
  const tool = () => STATIC_TOOL_CATALOGUE.find((d) => d.name === 'editor_run_console_command')!;

  it('accepts world under the strict parse hayba_invoke applies', () => {
    const strict = z.object(tool().schema).strict();
    expect(strict.safeParse({ command: 'Game.Weather Rain', world: 'pie' }).success).toBe(true);
  });

  it('forwards world to UE and leaves it out when not given', async () => {
    await tool().handler({ command: 'Game.Weather Rain', world: 'pie' }, undefined as never);
    await tool().handler({ command: 'stat unit' }, undefined as never);
    expect(calls).toEqual([
      { cmd: 'editor_run_console_command', params: { command: 'Game.Weather Rain', world: 'pie' } },
      { cmd: 'editor_run_console_command', params: { command: 'stat unit' } },
    ]);
  });
});

describe('during PIE (the owner drives its own game)', () => {
  const policy = readFileSync(
    join(here, '..', '..', '..', '..', '..', 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private',
      'HaybaMCPEditorStatePolicy.h'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const owner = policy.slice(policy.indexOf('PieOwnerCommands()'), policy.indexOf('return Commands;'));

  it('lets only the PIE owner run console commands, via the PIE-owner rule', () => {
    expect(owner).toContain('TEXT("editor_run_console_command"),');
    expect(owner).not.toContain('TEXT("python_run")');
  });

  it('refuses world editor while PIE runs, before anything executes', () => {
    const refusal = body.indexOf('is refused while a Play-In-Editor session runs');
    expect(refusal).toBeGreaterThan(-1);
    expect(body).toContain('if (Target == TEXT("editor") && GEditor && GEditor->PlayWorld)');
    expect(refusal).toBeLessThan(exec);
  });
});
