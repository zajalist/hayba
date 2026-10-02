/**
 * Save-site contract (T5; fails closed). Hayba has exactly one raw
 * UPackage::SavePackage, and it passes SAVE_NoError: without that flag a
 * read-only target can call appError through GError and leave the editor
 * unsafe. Every command that can overwrite a package
 * refuses a read-only one (RefuseIfReadOnly) before its first mutation, because
 * a refusal after a mutation reads as session_suspect. A new raw save, a new
 * engine save helper or a late preflight fails here until it is reviewed.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const UNREAL = join(here, '..', '..', '..', '..', 'unreal');
const TOOLKIT = 'HaybaMCPToolkit/Source/HaybaMCPToolkit';
const METASOUND = 'HaybaMCPMetaSound/Source/HaybaMCPMetaSound';

function cppFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'Intermediate' || name === 'Binaries' || name === 'Saved') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) cppFiles(path, out);
    else if (name.endsWith('.cpp') || name.endsWith('.h')) out.push(path);
  }
  return out;
}

/**
 * `code`: comments blanked. `skeleton`: comments and string/char literal
 * bodies blanked (so braces inside strings never count). Both keep every
 * index and newline, so an index found in one is valid in the other.
 */
function scanCpp(source: string): { code: string; skeleton: string } {
  const code = source.split('');
  const skeleton = source.split('');
  const blank = (arr: string[], from: number, to: number) => {
    for (let k = from; k < to; k += 1) if (arr[k] !== '\n') arr[k] = ' ';
  };
  const n = source.length;
  let i = 0;
  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(code, i, stop);
      blank(skeleton, i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(code, i, stop);
      blank(skeleton, i, stop);
      i = stop;
    } else if (c === 'R' && next === '"' && !/[A-Za-z0-9_]/.test(source[i - 1] ?? '')) {
      const open = source.indexOf('(', i + 2);
      const delimiter = source.slice(i + 2, open);
      const close = source.indexOf(`)${delimiter}"`, open + 1);
      const stop = close === -1 ? n : close + delimiter.length + 2;
      blank(skeleton, i + 2, stop - 1);
      i = stop;
    } else if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < n && source[k] !== c && source[k] !== '\n') k += source[k] === '\\' ? 2 : 1;
      blank(skeleton, i + 1, k);
      i = k + 1;
    } else {
      i += 1;
    }
  }
  return { code: code.join(''), skeleton: skeleton.join('') };
}

/** The body ({...}) of the first definition matching `anchor` (a declaration ending in ';' is skipped). */
function functionBody(scan: { code: string; skeleton: string }, anchor: string): string {
  for (let from = 0; ; ) {
    const at = scan.code.indexOf(anchor, from);
    if (at === -1) throw new Error(`anchor not found: ${anchor}`);
    const brace = scan.skeleton.indexOf('{', at);
    const semi = scan.skeleton.indexOf(';', at);
    if (brace !== -1 && (semi === -1 || brace < semi)) {
      let depth = 0;
      for (let k = brace; k < scan.skeleton.length; k += 1) {
        if (scan.skeleton[k] === '{') depth += 1;
        else if (scan.skeleton[k] === '}' && --depth === 0) return scan.code.slice(brace, k + 1);
      }
      throw new Error(`unbalanced braces after ${anchor}`);
    }
    from = at + anchor.length;
  }
}

function indicesOf(text: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) out.push(i);
  return out;
}

const files = cppFiles(UNREAL);
const scanned = new Map(files.map((f) => [relative(UNREAL, f).split('\\').join('/'), scanCpp(readFileSync(f, 'utf8'))]));
function at(path: string) {
  const s = scanned.get(path);
  if (!s) throw new Error(`not scanned: ${path}`);
  return s;
}

/** Minimum RefuseIfReadOnly(TEXT("<cmd>") call sites in the tree. */
const MIN_REFUSE_SITES = 11;

/** Each command's preflights, in order, each before the mutation token it guards. */
const SITES: Array<{ cmd: string; file: string; anchor: string; preflights: number; mutations: string[] }> = [
  {
    cmd: 'blueprint_compile',
    file: `${TOOLKIT}/Private/handlers/HaybaMCPBlueprintHandler.cpp`,
    anchor: 'FHaybaHandlerResult FHaybaMCPBlueprintHandler::Compile(',
    preflights: 1,
    mutations: ['CompileBlueprint('],
  },
  {
    cmd: 'create_graph',
    file: `${TOOLKIT}/Private/handlers/HaybaMCPLegacyHandler.cpp`,
    anchor: 'FHaybaHandlerResult FHaybaMCPLegacyHandler::Cmd_CreateGraph(',
    preflights: 1,
    mutations: ['CreatePackage('],
  },
  {
    cmd: 'metasound_compile',
    file: `${METASOUND}/Private/HaybaMCPMetaSoundHandler.cpp`,
    anchor: 'static FHaybaHandlerResult MSCompile(',
    preflights: 1,
    mutations: ['AttachBuilder('],
  },
  {
    cmd: 'ui_save_widget',
    file: `${TOOLKIT}/Private/handlers/HaybaMCPUIHandler.cpp`,
    anchor: 'FHaybaHandlerResult FHaybaMCPUIHandler::HandleSave(',
    preflights: 1,
    mutations: ['ReconcileWidgetVariableGuids('],
  },
  {
    cmd: 'ui_compile_widget',
    file: `${TOOLKIT}/Private/handlers/HaybaMCPUIHandler.cpp`,
    anchor: 'FHaybaHandlerResult FHaybaMCPUIHandler::HandleCompile(',
    preflights: 1,
    mutations: ['CompileWidgetBlueprint('],
  },
  {
    cmd: 'material_set_param',
    file: `${TOOLKIT}/Private/handlers/HaybaMCPMaterialHandler.cpp`,
    anchor: 'FHaybaHandlerResult FHaybaMCPMaterialHandler::MatSetParam(',
    preflights: 1,
    mutations: ['->Modify()'],
  },
  {
    cmd: 'material_compile',
    file: `${TOOLKIT}/Private/handlers/HaybaMCPMaterialHandler.cpp`,
    anchor: 'FHaybaHandlerResult FHaybaMCPMaterialHandler::MatCompile(',
    preflights: 2,
    mutations: ['UpdateMaterialFunction(', 'RecompileMaterial('],
  },
  {
    cmd: 'audio_asset_save',
    file: `${TOOLKIT}/Private/handlers/HaybaMCPAudioHandler.cpp`,
    anchor: 'FHaybaHandlerResult AudioAssetSave(',
    preflights: 1,
    mutations: ['SaveLoadedAsset('],
  },
  {
    cmd: 'level_save',
    file: `${TOOLKIT}/Private/handlers/HaybaMCPLevelHandler.cpp`,
    anchor: 'FHaybaHandlerResult FHaybaMCPLevelHandler::LevelSave(',
    preflights: 3,
    mutations: ['SanitizeTransientStaticMeshRefs('],
  },
  {
    cmd: 'editor_save_all_and_quit',
    file: `${TOOLKIT}/Private/handlers/HaybaMCPEditorHandler.cpp`,
    anchor: 'FHaybaHandlerResult FHaybaMCPEditorHandler::SaveAllAndQuit(',
    preflights: 1,
    mutations: ['SaveDirtyPackages('],
  },
];

describe('save-site contract', () => {
  it('scans the whole native tree', () => {
    expect(files.length).toBeGreaterThanOrEqual(150);
  });

  it('has exactly one raw UPackage::SavePackage, and it passes SAVE_NoError', () => {
    const sites = [...scanned].flatMap(([path, s]) => [...s.code.matchAll(/UPackage::SavePackage\s*\(/g)].map(() => path));
    expect(sites).toEqual([`${TOOLKIT}/Public/HaybaMCPSaveVerify.h`]);
    const body = functionBody(at(`${TOOLKIT}/Public/HaybaMCPSaveVerify.h`), 'inline bool SavePackageNoError(');
    expect(body).toContain('UPackage::SavePackage(');
    expect(body).toMatch(/SaveFlags\s*=\s*SAVE_NoError/);
  });

  it('keeps the engine-routed save helpers where they were reviewed (exact per-file counts)', () => {
    const helper = /\b(?:UEditorAssetLibrary|UEditorLoadingAndSavingUtils|FEditorFileUtils|UPackageTools|UEditorAssetSubsystem)::Save\w*\s*\(/g;
    const counts: Record<string, number> = {};
    for (const [path, s] of scanned) {
      if (path.includes('/Tests/')) continue;
      const n = [...s.code.matchAll(helper)].length;
      if (n > 0) counts[path] = n;
    }
    expect(counts).toEqual({
      [`${TOOLKIT}/Private/handlers/HaybaMCPAudioHandler.cpp`]: 1,
      [`${TOOLKIT}/Private/handlers/HaybaMCPDataAssetHandler.cpp`]: 1,
      [`${TOOLKIT}/Private/handlers/HaybaMCPEditorHandler.cpp`]: 1,
      [`${TOOLKIT}/Private/handlers/HaybaMCPLevelHandler.cpp`]: 2,
    });
  });

  it(`has at least ${MIN_REFUSE_SITES} preflights in the RefuseIfReadOnly(TEXT("<cmd>") form`, () => {
    let total = 0;
    for (const s of scanned.values()) total += [...s.code.matchAll(/RefuseIfReadOnly\(TEXT\("[a-z_]+"\)/g)].length;
    expect(total).toBeGreaterThanOrEqual(MIN_REFUSE_SITES);
  });

  it.each(SITES)('$cmd refuses a read-only package before its first mutation', ({ cmd, file, anchor, preflights, mutations }) => {
    const body = functionBody(at(file), anchor);
    const guards = indicesOf(body, `RefuseIfReadOnly(TEXT("${cmd}")`);
    expect(guards).toHaveLength(preflights);
    let previous = -1;
    for (const token of mutations) {
      const mutation = body.indexOf(token, previous + 1);
      expect(mutation, `${cmd}: ${token} is present`).toBeGreaterThan(-1);
      expect(guards.some((g) => g > previous && g < mutation), `${cmd}: a preflight precedes ${token}`).toBe(true);
      previous = mutation;
    }
    expect(Math.max(...guards), `${cmd}: every preflight precedes the last mutation`).toBeLessThan(previous);
  });
});

function indexAfter(text: string, pattern: RegExp, from: number): number {
  const re = new RegExp(pattern.source, 'g');
  re.lastIndex = from;
  const m = re.exec(text);
  return m ? m.index : -1;
}

describe('no save or Python site can open a modal on the game thread', () => {
  it('level_save runs SaveCurrentLevel with GIsRunningUnattendedScript set', () => {
    const body = functionBody(at(`${TOOLKIT}/Private/handlers/HaybaMCPLevelHandler.cpp`), 'FHaybaHandlerResult FHaybaMCPLevelHandler::LevelSave(');
    const guard = body.indexOf('TGuardValue<bool> UnattendedSave(GIsRunningUnattendedScript, true)');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf('SaveCurrentLevel('));
  });

  it('python_run sets EPythonCommandFlags::Unattended on every FPythonCommandEx before it runs', () => {
    const { code } = at(`${TOOLKIT}/Private/handlers/HaybaMCPPythonHandler.cpp`);
    expect(code).toContain('RunGuardedAt(EHaybaFaultSite::Python');
    const decls = [...code.matchAll(/FPythonCommandEx\s+(\w+)\s*;/g)];
    expect(decls.map((m) => m[1])).toEqual(['RunCmd', 'E', 'OkCmd', 'TimeoutCmd', 'CleanupCmd']);
    for (const decl of decls) {
      const name = decl[1]!;
      const from = decl.index!;
      const flag = code.indexOf(`${name}.Flags |= EPythonCommandFlags::Unattended;`, from);
      const runs = [indexAfter(code, new RegExp(`&${name}\\b`), from)]
        .filter((i) => i !== -1);
      expect(runs, `${name} has exactly one execution call`).toHaveLength(1);
      expect(flag, `${name} gets the Unattended flag`).toBeGreaterThan(from);
      expect(flag, `${name}: the flag is set before it runs`).toBeLessThan(Math.min(...runs));
    }
  });
});

// Engine helpers enter editor callbacks; preserve identity re-resolution while suppressing dialogs.
describe('engine save helper unattended scopes', () => {
  it.each([
    ['HaybaMCPAudioHandler.cpp', 'FHaybaHandlerResult AudioAssetSave(', 'SaveLoadedAsset('],
    ['HaybaMCPDataAssetHandler.cpp', 'FHaybaHandlerResult FHaybaMCPDataAssetHandler::Handle(', 'SaveLoadedAsset('],
    ['HaybaMCPEditorHandler.cpp', 'FHaybaHandlerResult FHaybaMCPEditorHandler::SaveAllAndQuit(', 'SaveDirtyPackages('],
    ['HaybaMCPLevelHandler.cpp', 'FHaybaHandlerResult FHaybaMCPLevelHandler::LevelCreate(', 'SaveLevel('],
  ])('%s guards %s', (file, anchor, call) => {
    const body = functionBody(at(`${TOOLKIT}/Private/handlers/${file}`), anchor!);
    const guard = body.indexOf('TGuardValue<bool> UnattendedSave(GIsRunningUnattendedScript, true)');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf(call!));
  });
});

it('level_create resolves the package to a map filename before SaveLevel', () => {
  const body = functionBody(at(`${TOOLKIT}/Private/handlers/HaybaMCPLevelHandler.cpp`), 'FHaybaHandlerResult FHaybaMCPLevelHandler::LevelCreate(');
  expect(body).toMatch(/HaybaSaveVerify::PackageFilename\(Path,\s*true\)/);
  expect(body).toContain('SaveLevel(World->GetCurrentLevel(), *MapFilename)');
});

it('discovers sanitizer candidates without mutation and preflights their actual packages', () => {
  const scan = at(`${TOOLKIT}/Private/handlers/HaybaMCPLevelHandler.cpp`);
  const discover = functionBody(scan, 'static TArray<FSanitizedStaticMeshRef> DiscoverTransientStaticMeshRefs(');
  expect(discover).not.toContain('->Modify(');
  expect(discover).not.toContain('->SetStaticMesh(');
  const save = functionBody(scan, 'FHaybaHandlerResult FHaybaMCPLevelHandler::LevelSave(');
  const found = save.indexOf('DiscoverTransientStaticMeshRefs(World)');
  const preflight = save.indexOf('Component->GetPackage()');
  const mutation = save.indexOf('SanitizeTransientStaticMeshRefs(');
  expect(found).toBeGreaterThan(-1);
  expect(preflight).toBeGreaterThan(found);
  expect(preflight).toBeLessThan(mutation);
});
