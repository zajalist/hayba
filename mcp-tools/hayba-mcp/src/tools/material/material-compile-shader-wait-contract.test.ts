import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const handler = readFileSync(
  join(root, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private', 'handlers', 'HaybaMCPMaterialHandler.cpp'),
  'utf8',
).replace(/\r\n/g, '\n'); // CRLF checkouts (core.autocrlf)

function between(start: string, end: string): string {
  const a = handler.indexOf(start);
  const b = handler.indexOf(end, a + start.length);
  expect(a, start).toBeGreaterThan(-1);
  expect(b, end).toBeGreaterThan(a);
  return handler.slice(a, b);
}

// material_compile used to answer ok after the translator passed, while the platform
// shader compile failed afterwards on worker threads; the material fell back to the
// default and M_UI_SandText's menu words rendered as nothing in game.
describe('material_compile waits for the real shader compile', () => {
  it('waits, bounded, on the editor shader platform and reads the resource errors', () => {
    const wait = between('static bool HaybaWaitForShaderMap(', 'FHaybaHandlerResult FHaybaMCPMaterialHandler::MatValidate(');
    expect(wait).toContain('GetMaterialResource(GMaxRHIShaderPlatform)');
    expect(wait).toContain('IsCompilationFinished()');
    expect(wait).toContain('FPlatformTime::Seconds() > Deadline');
    expect(wait).toContain('GetCompileErrors()');
    // FinishCompilation cannot be bounded; the wait must not call it.
    expect(wait).not.toContain('FinishCompilation(');
  });

  // RecompileMaterial caches with PrecompileMode::None, which submits no jobs for ANY domain: the
  // wait saw "finished" at once, and Post Process M_PP_MenuV31's FPostProcessMaterialPS failure
  // (PPI_POST_PROCESS_INPUT0 in Custom HLSL) surfaced only in game, after a clean report.
  it('submits the pending shader jobs, post-process domain included, before it starts waiting', () => {
    const wait = between('static bool HaybaWaitForShaderMap(', 'FHaybaHandlerResult FHaybaMCPMaterialHandler::MatValidate(');
    const submit = wait.indexOf('Resource->SubmitCompileJobs_GameThread(EShaderCompileJobPriority::High);');
    expect(submit).toBeGreaterThan(-1);
    expect(submit).toBeLessThan(wait.indexOf('while (!Resource->IsCompilationFinished())'));
    // One resource holds every shader type of the material's own domain and usage (FPostProcessMaterialPS
    // for MD_PostProcess), so the wait and the compile verdict must not branch on the domain.
    const compile = between('static bool HaybaWaitForShaderMap(', '// ── Optimization feedback');
    expect(compile).not.toMatch(/MaterialDomain|MD_PostProcess|MD_Surface|IsPostProcessMaterial/);
  });

  it('decides ok and the save from the shader result, and never saves on a timeout', () => {
    const compile = between('FHaybaHandlerResult FHaybaMCPMaterialHandler::MatCompile(', '// ── Optimization feedback');
    const waitAt = compile.indexOf('HaybaWaitForShaderMap(W->Material, 30.0');
    expect(waitAt).toBeGreaterThan(compile.indexOf('UMaterialEditingLibrary::RecompileMaterial'));
    expect(waitAt).toBeLessThan(compile.indexOf('HaybaPersistAsset(Mat, SaveErr)'));
    expect(compile).toContain('const bool bCompiledClean = CompileErrors.Num() == 0 && !bShaderTimedOut;');
    expect(compile).toContain('TEXT("shader_compile_timed_out")');
  });

  it('material_validate compile:true runs the same wait and never saves', () => {
    const validate = between('FHaybaHandlerResult FHaybaMCPMaterialHandler::MatValidate(', 'FHaybaHandlerResult FHaybaMCPMaterialHandler::MatCompile(');
    expect(validate).toContain('TryGetBoolField(TEXT("compile"), bCompileRequested)');
    expect(validate).toContain('HaybaWaitForShaderMap(C->Material, 30.0');
    expect(validate).not.toContain('HaybaPersistAsset');
  });

  it('lints Custom node HLSL in the shared preflight, before any compile', () => {
    const preflight = between('static void CollectMaterialGraphProblems(', 'static void GatherMaterialPropertyInputs(');
    expect(preflight).toContain('HaybaMaterialLint::LintCustomHlsl(Custom->Code)');
  });
});
