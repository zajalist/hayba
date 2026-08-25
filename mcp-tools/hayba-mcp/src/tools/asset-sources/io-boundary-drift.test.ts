import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CONNECTOR_ROOT = dirname(fileURLToPath(import.meta.url));
const VALIDATOR_ROOT = join(CONNECTOR_ROOT, '..', '..', 'validator');

interface ProductionSource {
  relativePath: string;
  source: string;
}

function productionSources(root: string, directory = root): ProductionSource[] {
  const out: ProductionSource[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      out.push(...productionSources(root, fullPath));
      continue;
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    out.push({ relativePath: relative(root, fullPath).replaceAll('\\', '/'), source: readFileSync(fullPath, 'utf8') });
  }
  return out.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'));
}

const forbiddenPythonModuleImport =
  /^\s*['"`]?\s*(?:import\s+(?![<{*]|type\b)[^'"`\r\n]*\b(?:os|pathlib|shutil|io|builtins)\b|from\s+(?:os|pathlib|shutil|io|builtins)(?:\.\w+)*\s+import\b)/gm;
const forbiddenPythonFilePrimitive =
  /(?:^|[^.\w])open\s*\(|\b(?:__builtins__|__import__\s*\(|builtins\.open\b|pathlib\b|shutil\b|io\.open\b|os\.(?:walk|listdir|scandir|path|open|remove|unlink|rename|replace|mkdir|makedirs|rmdir)\b|\w+\s*=\s*(?:open|builtins\.open|pathlib\.Path|io\.open|shutil\.\w+))/;
const forbiddenUnrealFilePrimitive =
  /unreal\.(?:Paths?\b|FileHelper\b|PlatformFileManager\b|SystemLibrary\.(?:get_project_directory|get_project_saved_directory|delete_file|delete_directory|make_directory)|EditorAssetLibrary\.(?:save_asset|save_directory|delete_asset|delete_directory|rename_asset|duplicate_asset|make_directory))\b|\w+\s*=\s*unreal\.(?:Paths?|FileHelper|PlatformFileManager|SystemLibrary|EditorAssetLibrary)\b/;

function joined(sources: ProductionSource[]): string {
  return sources.map((item) => `// ${item.relativePath}\n${item.source}`).join('\n');
}

describe('recursive connector and validator I/O ownership drift', () => {
  const connectors = productionSources(CONNECTOR_ROOT);
  const validators = productionSources(VALIDATOR_ROOT);

  it('recursively inventories every production source in both boundaries', () => {
    expect(connectors.map((item) => item.relativePath)).toEqual(
      expect.arrayContaining([
        'ambientcg-download.ts',
        'polyhaven-download.ts',
        'secure-archive.ts',
        'shared.ts',
        'sketchfab-download.ts',
      ]),
    );
    expect(validators.map((item) => item.relativePath)).toEqual(
      expect.arrayContaining(['tool-hooks.ts', 'ue-probe.ts', 'ui/rules.ts']),
    );
  });

  it('forbids connector Python continuations and direct native asset_import', () => {
    const source = joined(connectors);
    expect(source).not.toMatch(/['"]python_run['"]/);
    expect(source).not.toMatch(/['"]asset_import['"]/);
    expect(source).not.toMatch(/executeCommand[^(]{0,160}\(\s*['"](?:python_run|asset_import)['"]/);
    expect(source).not.toMatch(/\.send\s*\(\s*['"](?:python_run|asset_import)['"]/);
  });

  it('allows one guarded validator probe and forbids production safety overrides', () => {
    const invocations = validators.flatMap((item) => [
      ...item.source.matchAll(/executeCommand[^(]{0,160}\(\s*['"]python_run['"]/g),
    ]);
    expect(invocations).toHaveLength(1);
    expect(
      validators.find((item) => /executeCommand[^(]{0,160}\(\s*['"]python_run['"]/.test(item.source))?.relativePath,
    ).toBe('ue-probe.ts');
    expect(joined(validators)).not.toMatch(/allow_unsafe\s*:\s*true/);
    expect(joined(validators)).not.toMatch(/['"]asset_import['"]/);
  });

  it('forbids embedded filesystem Python, aliases, and Unreal file APIs recursively', () => {
    for (const item of [...connectors, ...validators]) {
      expect(item.source, item.relativePath).not.toMatch(forbiddenPythonModuleImport);
      expect(item.source, item.relativePath).not.toMatch(forbiddenPythonFilePrimitive);
      expect(item.source, item.relativePath).not.toMatch(forbiddenUnrealFilePrimitive);
      forbiddenPythonModuleImport.lastIndex = 0;
    }
  });

  it('pins connector enumeration to bounded streaming opendir', () => {
    const shared = connectors.find((item) => item.relativePath === 'shared.ts')!.source;
    expect(shared).toContain('fsp.opendir(');
    expect(shared).not.toContain('fsp.readdir(');
    expect(shared).toContain('entriesVisited > limits.maxEntries');
  });

  it('keeps the drift detectors sensitive to aliases and alternate file APIs', () => {
    for (const sample of [
      "'import os as host'",
      "'import pathlib as paths'",
      "'import json, os as host'",
      "'from shutil import rmtree as wipe'",
      '`import io as streams`',
      "'from builtins import open as reader'",
    ]) {
      expect(sample).toMatch(forbiddenPythonModuleImport);
      forbiddenPythonModuleImport.lastIndex = 0;
    }
    for (const sample of [
      "'reader = open'",
      "'pathlib.Path(root).write_text(data)'",
      "'io.open(path)'",
      "'__import__(name)'",
    ]) {
      expect(sample).toMatch(forbiddenPythonFilePrimitive);
    }
    for (const sample of [
      "'unreal.Paths.project_dir()'",
      "'unreal.SystemLibrary.delete_file(path)'",
      "'unreal.EditorAssetLibrary.save_asset(path)'",
      "'files = unreal.SystemLibrary'",
    ]) {
      expect(sample).toMatch(forbiddenUnrealFilePrimitive);
    }
    expect("executeCommand('asset_import', params)").toMatch(
      /executeCommand[^(]{0,160}\(\s*['"](?:python_run|asset_import)['"]/,
    );
  });
});
