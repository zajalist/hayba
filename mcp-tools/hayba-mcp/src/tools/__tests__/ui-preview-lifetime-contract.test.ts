/**
 * Cross-language guard for the native UMG preview lifecycle.
 *
 * The behavioral proof lives in Hayba.MCP.UI.PreviewLifetimePreservesUndoAndGCs;
 * these checks keep future refactors from silently reintroducing the two exact
 * hazards before a UE test build is available: wrapping UMG compilation in the
 * global undo buffer, or creating transactional renderer previews.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd(), '../../unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit');
const COMMAND_CPP = join(ROOT, 'Private/HaybaMCPCommandHandler.cpp');
const LAYOUT_CPP = join(ROOT, 'Private/handlers/HaybaMCPUILayout.cpp');
const UI_HANDLER_CPP = join(ROOT, 'Private/handlers/HaybaMCPUIHandler.cpp');
const NATIVE_TEST_CPP = join(ROOT, 'Private/Tests/HaybaMCPUIPreviewLifetimeTest.cpp');

function readNativeSource(path: string): string {
  // Git checks native sources out as CRLF on Windows. Contract assertions
  // must describe source content, not the host's line-ending convention.
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

function bodyBetween(source: string, startToken: string, endToken: string): string {
  const start = source.indexOf(startToken);
  expect(start, `missing native contract token: ${startToken}`).toBeGreaterThan(-1);
  const end = source.indexOf(endToken, start);
  expect(end, `missing native contract end token: ${endToken}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('native UMG preview lifetime contract', () => {
  const available = [COMMAND_CPP, LAYOUT_CPP, UI_HANDLER_CPP, NATIVE_TEST_CPP].every(existsSync);

  it.runIf(available)('keeps compile Plan-gated but excludes only its derived work from undo', () => {
    const source = readNativeSource(COMMAND_CPP);
    const gate = bodyBetween(source, 'static const TSet<FString> DestructiveCommands', '};');
    const transactionPolicy = bodyBetween(
      source,
      'bool FHaybaMCPCommandHandler::ShouldCreateEditorTransaction',
      'FHaybaMCPCommandHandler::FHaybaMCPCommandHandler',
    );

    expect(gate).toContain('TEXT("ui_compile_widget")');
    expect(transactionPolicy).toContain('Cmd == TEXT("ui_compile_widget")');
    expect(transactionPolicy).toContain('return false');
    expect(transactionPolicy).not.toContain('Reset(');
    expect(transactionPolicy).not.toContain('DisableObjectSerialization');
  });

  it.runIf(available)('makes the whole preview graph transient and non-transactional', () => {
    const source = readNativeSource(LAYOUT_CPP);
    const create = bodyBetween(source, 'bool MakePreviewInstance', 'bool ComputeGeometry');
    const destroy = bodyBetween(source, 'FPreviewInstance::~FPreviewInstance', 'bool MakePreviewInstance');

    expect(create).toContain('RF_Transient');
    expect(create).toContain('Instance->ClearFlags(RF_Transactional)');
    expect(create).toContain('ForEachObjectWithOuter(Instance');
    expect(create).toContain('PreviewObject->ClearFlags(RF_Transactional)');
    expect(create).toContain('TGuardValue<ITransaction*> SuppressPreviewTransactions(GUndo, nullptr)');
    expect(destroy.indexOf('Slate.Reset()')).toBeLessThan(destroy.indexOf('Instance->MarkAsGarbage()'));
  });

  it.runIf(available)('suppresses only compile-time recording when another gesture owns GUndo', () => {
    const source = readNativeSource(UI_HANDLER_CPP);
    const compile = bodyBetween(source, 'FCompileResult CompileWidgetBlueprint', 'HaybaSaveVerify::FResult');
    expect(compile).toContain('TGuardValue<ITransaction*> SuppressCompileTransactions(GUndo, nullptr)');
    expect(compile).not.toContain('Reset(');
    expect(compile).not.toContain('DisableObjectSerialization');
    expect(compile).not.toContain('CancelTransaction');
  });

  it.runIf(available)('retains repeated GC and undo-preservation native coverage', () => {
    const source = readNativeSource(NATIVE_TEST_CPP);
    expect(source).toContain('PreviewLifetimePreservesUndoAndGCs');
    expect(source).toContain('Iteration < 8');
    expect(source).toContain('Iteration < 3');
    expect(source).toContain('GCCycle < 3');
    expect(source).toContain('CollectGarbage(RF_NoFlags)');
    expect(source).toContain('TStrongObjectPtr<UTransactor> Original');
    expect(source).toContain('ITransaction* OriginalUndo');
    expect(source).toContain('Original->IsActive() || OriginalUndo != nullptr');
    expect(source).toContain('GUndo = nullptr');
    expect(source).toContain('GUndo = OriginalUndo');
    expect(source).toContain('AddError(TEXT("Slate is not initialized');
    expect(source).toContain('original editor transactor survives GC cycle %d');
    expect(source).toContain('WBP->SetFlags(RF_Transactional)');
    expect(source).toContain('WBP->ThumbnailCustomSize.X = OriginalThumbnailSize.X + 1.0');
    expect(source).toContain('Keep the isolated\n        // buffer installed through cleanup');
    expect(source).toContain('FSlateApplication::Get().Tick()');
    expect(source).toContain('FlushRenderingCommands()');
    expect(source).toContain('real undo queue is untouched');
    expect(source).toContain('compile preview world');
  });
});
