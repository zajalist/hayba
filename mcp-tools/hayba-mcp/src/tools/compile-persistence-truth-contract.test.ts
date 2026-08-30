import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');
const handlers = join(repo, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private');
const read = (relative: string): string => readFileSync(join(handlers, relative), 'utf8');

describe('compile and persistence truth contract', () => {
  it('promotes failed widget compiles while preserving their structured diagnostics', () => {
    const ui = read(join('handlers', 'HaybaMCPUIHandler.cpp'));
    const describe = ui.slice(
      ui.indexOf('void DescribeCompileResult('),
      ui.indexOf('HaybaSaveVerify::FResult SaveWidgetPackage'),
    );
    for (const fact of ['ok', 'success', 'compiled_clean', 'status', 'warnings', 'errors', 'error']) {
      expect(describe).toContain(`TEXT("${fact}")`);
    }

    const compile = ui.slice(
      ui.indexOf('FHaybaMCPUIHandler::HandleCompile('),
      ui.indexOf('FHaybaMCPUIHandler::HandleSave('),
    );
    expect(compile).toContain('DescribeCompileResult(CR, Out)');

    const save = ui.slice(
      ui.indexOf('FHaybaMCPUIHandler::HandleSave('),
      ui.indexOf('FHaybaMCPUIHandler::HandleListTypes('),
    );
    const compileFailure = save.slice(
      save.indexOf('if (!CR.bSuccess)'),
      save.indexOf('const HaybaSaveVerify::FResult'),
    );
    expect(compileFailure).toContain('DescribeCompileResult(CR, Out)');
    expect(compileFailure).toContain('TEXT("compile_failed")');
    expect(compileFailure).toContain('TEXT("save_attempted"), false');
  });

  it('never persists a material whose compile produced errors', () => {
    const material = read(join('handlers', 'HaybaMCPMaterialHandler.cpp'));
    const compile = material.slice(
      material.indexOf('FHaybaMCPMaterialHandler::MatCompile('),
      material.indexOf('FHaybaMCPMaterialHandler::MatDisconnect('),
    );
    const persistenceStart = compile.indexOf('const bool bCompiledClean = CompileErrors.Num() == 0');
    const persistence = compile.slice(
      persistenceStart,
      compile.indexOf('Out = MakeShared<FJsonObject>()', persistenceStart),
    );
    expect(persistence).toContain('if (bCompiledClean)');
    expect(persistence).toContain('bSaved = HaybaPersistAsset(Mat, SaveErr)');
    expect(persistence.indexOf('if (bCompiledClean)')).toBeLessThan(
      persistence.indexOf('bSaved = HaybaPersistAsset(Mat, SaveErr)'),
    );
    expect(compile).toContain('TEXT("ok"), bCompiledClean && bSaved');
    expect(compile).toContain('TEXT("compiled_clean"), bCompiledClean');
    expect(compile).toContain('shader compilation failed; the material was not saved');
    expect(compile).toContain('Out->GetBoolField(TEXT("compiled_clean"))');
  });

  it('marks every structured material preflight and native-crash result as failure', () => {
    const material = read(join('handlers', 'HaybaMCPMaterialHandler.cpp'));
    const compile = material.slice(
      material.indexOf('FHaybaMCPMaterialHandler::MatCompile('),
      material.indexOf('FHaybaMCPMaterialHandler::MatDisconnect('),
    );
    expect(compile.match(/Bad->SetBoolField\(TEXT\("ok"\), false\)/g)).toHaveLength(4);
    expect(compile.match(/Bad->SetStringField\(TEXT\("error"\)/g)).toHaveLength(4);
    expect(compile).toContain('FnOut->SetBoolField(TEXT("ok"), bFnSaved)');
    const functionSuccess = compile.slice(
      compile.indexOf('const bool bFnSaved = HaybaPersistAsset'),
      compile.indexOf('UMaterial* Mat = LoadObject'),
    );
    expect(functionSuccess).toContain('FnOut->SetBoolField(TEXT("update_completed"), true)');
    expect(functionSuccess).not.toContain('TEXT("compiled_clean")');
    expect(compile).toContain('function update completed, but persistence verification failed');

    const statsGuard = compile.slice(
      compile.indexOf('bool bStatsCrashed = false'),
      compile.indexOf('// Local name map'),
    );
    expect(statsGuard).toContain('if (bStatsCrashed)');
    expect(statsGuard).toContain('TEXT("ok"), false');
    expect(statsGuard).toContain('TEXT("session_suspect"), true');
    expect(statsGuard).toContain('No further FMaterialResource access was attempted');
    expect(statsGuard).toContain('return FHaybaHandlerResult::Ok(Out)');
    expect(statsGuard).not.toContain('Res->');

    const functionFault = compile.slice(
      compile.indexOf('if (bFnCrashed)'),
      compile.indexOf('FString FnSaveErr'),
    );
    const materialFault = compile.slice(
      compile.indexOf('if (bCompileCrashed)'),
      compile.indexOf('TArray<TSharedPtr<FJsonValue>> Errs'),
    );
    for (const guardedFault of [functionFault, materialFault]) {
      expect(guardedFault).toContain('TEXT("session_suspect"), true');
      expect(guardedFault).toContain('Restart the editor before another mutation');
    }
  });

  it('keeps every command-boundary panel update synchronous and refuses off-thread dispatch', () => {
    const command = read('HaybaMCPCommandHandler.cpp');
    const toolStream = command.slice(
      command.indexOf('// Push to Tool Stream — first into the module-level history buffer'),
      command.indexOf(
        'if (Result.bOk)',
        command.indexOf('// Push to Tool Stream — first into the module-level history buffer'),
      ),
    );
    expect(toolStream).toContain('M->RecordToolCall(Cmd, ParamsStr, ResultStr)');
    expect(toolStream).toContain('if (IsInGameThread())');
    expect(toolStream).toContain('Panel->AddToolCall(Cmd, ParamsStr, ResultStr)');
    expect(toolStream).not.toContain('AsyncTask(');
    expect(command).not.toContain('AsyncTask(ENamedThreads::GameThread,');
    const processCommand = command.slice(command.indexOf('FString FHaybaMCPCommandHandler::ProcessCommand('));
    const threadRefusal = processCommand.indexOf('if (!IsInGameThread())');
    const jsonParsing = processCommand.indexOf('TJsonReaderFactory<>::Create(CommandJson)');
    const authGate = processCommand.indexOf('ValidateRequest(Parsed, AuthReason)');
    expect(threadRefusal).toBeGreaterThan(-1);
    expect(threadRefusal).toBeLessThan(jsonParsing);
    expect(threadRefusal).toBeLessThan(authGate);
    expect(processCommand.slice(threadRefusal, jsonParsing)).toContain('MakeOffGameThreadResponse()');

    const fixedRefusal = command.slice(
      command.indexOf('static FString MakeOffGameThreadResponse()'),
      command.indexOf('static FString ShapeOkResponse('),
    );
    expect(fixedRefusal).toContain('no operation was started');
    expect(fixedRefusal).not.toContain('MakeErrorResponse');
    expect(fixedRefusal).not.toContain('FHaybaMCPSettings');
    expect(fixedRefusal).not.toContain('FModuleManager');

    const module = read('HaybaMCPModule.cpp');
    const record = module.slice(
      module.indexOf('void FHaybaMCPModule::RecordToolCall('),
      module.indexOf('TArray<FHaybaToolCallRecord> FHaybaMCPModule::SnapshotToolCalls'),
    );
    expect(record).toContain('if (IsInGameThread())');
    expect(record).toContain('OnToolCallRecorded.Broadcast(Rec)');
    expect(record).toContain('skipped live subscriber broadcast');
    expect(record).not.toContain('AsyncTask(');
    expect(command).toContain('TEXT("session_suspect"), bSessionSuspect');
    expect(command).toContain('EHaybaMCPFailureKind::SessionSuspect');
  });

  it('revokes every module-owned callback before hot unload', () => {
    const module = read('HaybaMCPModule.cpp');
    const header = read(join('..', 'Public', 'HaybaMCPModule.h'));
    const shutdown = module.slice(
      module.indexOf('void FHaybaMCPModule::ShutdownModule()'),
      module.indexOf('TSharedPtr<FJsonObject> FHaybaMCPModule::GetTcpTransportLimits'),
    );

    // A task-graph lambda's call operator lives in the plugin DLL even when it
    // captures no module pointer. Startup UI work therefore stays synchronous.
    expect(module).not.toContain('AsyncTask(ENamedThreads::GameThread,');

    for (const command of ['OpenToolkitConsoleCommand', 'OpenStudioConsoleCommand']) {
      expect(header).toContain(`IConsoleObject* ${command} = nullptr`);
      expect(module).toContain(`${command} = IConsoleManager::Get().RegisterConsoleCommand(`);
      expect(shutdown).toContain(`UnregisterConsoleObject(${command}, false)`);
      expect(shutdown).toContain(`${command} = nullptr`);
    }

    expect(header).toContain('FTimerHandle AutoOpenTimerHandle');
    expect(module).toContain('AutoOpenTimerHandle = GEditor->GetTimerManager()->SetTimerForNextTick(');
    expect(module).toContain('CreateRaw(this, &FHaybaMCPModule::OpenOnboardingTab)');
    expect(shutdown).toContain('ClearTimer(AutoOpenTimerHandle)');
    expect(shutdown).toContain('AutoOpenTimerHandle.Invalidate()');

    for (const handle of ['StudioMenuStartupHandle', 'PlanModeMenuStartupHandle']) {
      expect(header).toContain(`FDelegateHandle ${handle}`);
      expect(module).toContain(`${handle} = UToolMenus::RegisterStartupCallback(`);
      expect(shutdown).toContain(`UToolMenus::UnRegisterStartupCallback(${handle})`);
      expect(shutdown).toContain(`${handle}.Reset()`);
    }
    expect(module.match(/FToolMenuOwnerScoped OwnerScoped\(this\)/g)).toHaveLength(2);
    expect(shutdown).toContain('UToolMenus::UnregisterOwner(this)');
  });
});
