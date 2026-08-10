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
    const source = readFileSync(COMMAND_CPP, 'utf8');
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
    const source = readFileSync(LAYOUT_CPP, 'utf8');
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
    const source = readFileSync(UI_HANDLER_CPP, 'utf8');
    const compile = bodyBetween(source, 'FCompileResult CompileWidgetBlueprint', 'HaybaSaveVerify::FResult');
    expect(compile).toContain('TGuardValue<ITransaction*> SuppressCompileTransactions(GUndo, nullptr)');
    expect(compile).not.toContain('Reset(');
    expect(compile).not.toContain('DisableObjectSerialization');
    expect(compile).not.toContain('CancelTransaction');
  });

  it.runIf(available)('retains repeated GC and undo-preservation native coverage', () => {
    const source = readFileSync(NATIVE_TEST_CPP, 'utf8');
    expect(source).toContain('PreviewLifetimePreservesUndoAndGCs');
    expect(source).toContain('Iteration < 8');
    expect(source).toContain('Iteration < 3');
    expect(source).toContain('CollectGarbage(RF_NoFlags)');
    expect(source).toContain('real undo queue is untouched');
    expect(source).toContain('compile preview world');
  });
});
