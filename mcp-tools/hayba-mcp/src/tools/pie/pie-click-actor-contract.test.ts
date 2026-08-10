import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { NON_IDEMPOTENT } from '../tool-executor.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const pluginRoot = join(here, '../../../../../unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit');
const handler = readFileSync(join(pluginRoot, 'Private/handlers/HaybaMCPPIEHandler.cpp'), 'utf8');
const runtimeOps = readFileSync(join(pluginRoot, 'Private/HaybaPIERuntimeOps.cpp'), 'utf8');
const commandHandler = readFileSync(join(pluginRoot, 'Private/HaybaMCPCommandHandler.cpp'), 'utf8');

const clickStart = handler.indexOf('FHaybaHandlerResult FHaybaMCPPIEHandler::PIEClickActor');
const clickEnd = handler.indexOf('#else  // !WITH_EDITOR', clickStart);
const click = handler.slice(clickStart, clickEnd);

describe('exact PIE actor interaction is fail-closed and OS-input-free', () => {
  it('is registered on both protocol sides and protected from retry/Plan Mode drift', () => {
    expect(handler).toContain('TEXT("editor_pie_click_actor")');
    expect(handler).toContain('return PIEClickActor(Params)');
    expect(NON_IDEMPOTENT.has('editor_pie_click_actor')).toBe(true);

    const destructiveStart = commandHandler.indexOf('static const TSet<FString> DestructiveCommands');
    const destructiveEnd = commandHandler.indexOf('};', destructiveStart);
    expect(commandHandler.slice(destructiveStart, destructiveEnd)).toContain('TEXT("editor_pie_click_actor")');
    expect(commandHandler).toContain('Cmd == TEXT("ui_compile_widget") || Cmd == TEXT("editor_pie_click_actor")');
  });

  it('reuses the projection proof and refuses a response that is not target-click-ready', () => {
    expect(clickStart).toBeGreaterThan(-1);
    expect(click.length).toBeGreaterThan(4_000);
    expect(click).toContain('PIEProjectWorld(P)');
    expect(click).toContain('target_click_ready');
    expect(click).toContain('refused unverified target');
    expect(click).toContain('Visibility hit no longer belongs to the requested actor');
    expect(click).toContain('requested component is not the first Visibility hit');
  });

  it('never routes synthetic pointer input and dispatches only the exact native primitive stage', () => {
    expect(click).not.toMatch(/\bSetCursorPos\s*\(/);
    expect(click).not.toContain('SetMouse(');
    expect(click).not.toContain('ProcessMouseButton');
    expect(click).not.toContain('NotifyActorOnClicked');
    expect(click).not.toContain('NotifyActorBeginCursorOver');
    expect(click).not.toContain('DispatchMouseOverEvents');
    expect(click).not.toContain('ProcessMouseMoveEvent(MoveEvent)');
    expect(click).not.toMatch(/->OnMouseMove\s*\(/);
    expect(click).not.toContain('SceneViewport->UpdateCachedCursorPos');
    expect(click).not.toContain('NotifyPointerMoveBegin');
    expect(click).not.toContain('NotifyPointerMoveComplete');
    expect(click).not.toContain('OnMouseEnter(');
    expect(click).toContain('Slate.LocateWindowUnderMouse');
    expect(click).toContain('PressComponent->DispatchOnClicked(EKeys::LeftMouseButton)');
    expect(click).toContain('WeakHitComponent->DispatchOnReleased(EKeys::LeftMouseButton)');
    expect(click).not.toContain('PlayerController->InputKey(PressArgs)');
    expect(click).toContain('APlayerController::InputKey cannot be made exact');
  });

  it('honours native player-controller input policy before gameplay dispatch', () => {
    expect(click).toContain('ViewportClient->IgnoreInput()');
    expect(click).toContain('PlayerController->PlayerInput');
    expect(click).toContain('PlayerController->CurrentClickTraceChannel != ECC_Visibility');
    expect(click).toContain('PlayerController->bEnableClickEvents');
    expect(click).toContain('PlayerController->ClickEventKeys.Contains(EKeys::LeftMouseButton)');
    expect(click).toContain('GetHitBoxAtCoordinates(ViewportPoint, false)');
    expect(click).toContain('Canvas HUD hit box');
  });

  it('uses canonical split-screen order and rejects hover before any runtime mutation', () => {
    expect(handler).toContain('GameInstance->GetLocalPlayerByIndex(PlayerIndex)');
    expect(handler).not.toContain('SyntheticHoveredPrimitives');
    expect(click).not.toContain('queued_for_next_player_input_tick');
    expect(runtimeOps).toContain('exact hover is unavailable');
    expect(click).not.toContain('synthetic_hover_matches');
  });

  it('rejects hidden or unregistered primitive targets and re-proves before release', () => {
    expect(click).toContain('RequiredComponent->bHiddenInGame');
    expect(click).toContain('HitComponent->bHiddenInGame');
    expect(click).toContain('ValidateExactInteractionState');
    expect(click).toContain('first Visibility hit no longer matches the exact target');
    expect(click).toContain('Slate/UMG no longer routes the selected user directly to the viewport');
    expect(click).toContain('a Canvas HUD hit box blocks the target');
    expect(click).toContain('viewport, PlayerInput, or Visibility click policy changed');
    expect(click).toContain('LocalSlateUser->IsDragDropping()');
  });

  it('reports dispatch and only the generic postconditions it can actually observe', () => {
    expect(click).toContain('os_input_used');
    expect(click).toContain('desktop_cursor_moved');
    expect(click).toContain('target_valid_after');
    expect(click).toContain('component_valid_after');
    expect(click).toContain('application_specific_state_observed');
    expect(click).toContain('Proof.Data->SetObjectField(TEXT("postcondition")');
  });

  it('rejects coordinate fallback and disabled visibility proof on the direct wire', () => {
    expect(runtimeOps).toContain('world_location is not supported; pass exactly one actor reference');
    expect(runtimeOps).toContain('trace_visibility cannot be disabled for actor interaction');
    expect(runtimeOps).toContain("'action' must be click; exact hover is unavailable");
    expect(runtimeOps).toContain("unknown field '%s'");
  });

  it('preserves exact runtime paths through response limiting', () => {
    const limitsStart = commandHandler.indexOf('FHaybaResponseLimits Limits');
    const limitsEnd = commandHandler.indexOf('FHaybaMCPResponseBuilder Builder', limitsStart);
    expect(commandHandler.slice(limitsStart, limitsEnd)).toContain('Cmd == TEXT("editor_pie_click_actor")');
    expect(commandHandler.slice(limitsStart, limitsEnd)).toContain('Limits.MaxStringChars = 2048');
  });
});
