import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { NON_IDEMPOTENT } from '../tool-executor.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const cpp = readFileSync(
  join(here, '../../../../../unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPPIEHandler.cpp'),
  'utf8',
);
const ops = readFileSync(
  join(here, '../../../../../unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaPIERuntimeOps.cpp'),
  'utf8',
);
const commandHandler = readFileSync(
  join(here, '../../../../../unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCommandHandler.cpp'),
  'utf8',
);

const commands = ['editor_pie_actor_list', 'editor_pie_actor_inspect', 'editor_pie_project_world'];

describe('PIE runtime inspection is a bounded read-only surface', () => {
  it('does not classify observation as a retry-unsafe mutation', () => {
    for (const command of commands) expect(NON_IDEMPOTENT.has(command)).toBe(false);
  });

  it('rejects any globally-resolved exact path unless it belongs to the selected live PIE world', () => {
    const slice = cpp.slice(cpp.indexOf('// Read-only runtime scene grounding'), cpp.indexOf('#else  // !WITH_EDITOR'));
    expect(slice.length).toBeGreaterThan(1_000);
    expect(slice).toContain('FindObject<AActor>(nullptr, *Reference.Path)');
    expect(slice).toContain('Actor->GetWorld() == ExpectedWorld');
    expect(slice).toMatch(/PathMatch[\s\S]{0,200}RuntimeActorIsUsable\(PathMatch, World\)/);
    expect(slice).toContain('Component->GetOwner() != Actor');
  });

  it('caps scans, retained matches, pages, tags and components', () => {
    expect(cpp).toContain('MaxActorsScanned = 100000');
    expect(cpp).toContain('MaxRetainedActorMatches');
    expect(cpp).toContain('MaxActorResolutionScans = 20000');
    expect(cpp).toContain('MaxTagsReported = 50');
    expect(cpp).toContain('MaxPIEWorldsReported = 50');
    expect(ops).toContain('OptionalBoundedInt(R, TEXT("limit"), 1, MaxListLimit)');
    expect(ops).toContain('OptionalBoundedInt(R, TEXT("component_limit"), 1, MaxComponents)');
  });

  it('encodes broken runtime transforms without emitting non-standard JSON numbers', () => {
    expect(cpp).toContain('IsFiniteVector');
    expect(cpp).toContain('IsFiniteRotator');
    expect(cpp).toContain('invalid_numeric');
  });

  it('derives absolute pixels from SViewport geometry, not outer-window guesses', () => {
    const projection = cpp.slice(cpp.indexOf('FHaybaHandlerResult FHaybaMCPPIEHandler::PIEProjectWorld'));
    expect(projection).toContain('GetGameViewportWidget');
    expect(projection).toContain('GetCachedGeometry');
    expect(projection).toContain('LocalToAbsolute');
    expect(projection).not.toContain('GetPositionInScreen');
    expect(projection).toContain('/*bPlayerViewportRelative=*/false');
  });

  it('reports the actual visibility-channel hit and a non-success verdict when target is unproven', () => {
    expect(cpp).toContain('GetHitResultAtScreenPosition');
    expect(cpp).toContain('ECC_Visibility');
    expect(cpp).toContain('another_object_is_first_world_visibility_hit');
    expect(cpp).toContain('no_blocking_hit_target_not_proven');
    expect(cpp).toContain('do not guess absolute mouse coordinates');
    expect(cpp).toContain('projection produced non-finite screen coordinates');
    expect(cpp).toContain('target_click_ready');
    expect(cpp).toContain('target_is_not_first_world_visibility_hit');
  });

  it('distinguishes component bounds from a component pivot', () => {
    expect(cpp).toContain('Primitive->Bounds.Origin');
    expect(cpp).toContain('component_bounds_origin');
    expect(cpp).toContain("pass sample:'component_location'");
  });

  it("does not intern untrusted tag filters into Unreal's permanent name pool", () => {
    expect(cpp).toContain('FName(*Request.Tag, FNAME_Find)');
    expect(cpp).not.toContain('ActorHasTag(FName(*Request.Tag))');
  });

  it('preserves exact long runtime object paths through the native response limiter', () => {
    const responseLimits = commandHandler.slice(
      commandHandler.indexOf('FHaybaResponseLimits Limits'),
      commandHandler.indexOf('FHaybaMCPResponseBuilder Builder'),
    );
    expect(responseLimits).toContain('editor_pie_actor_list');
    expect(responseLimits).toContain('editor_pie_actor_inspect');
    expect(responseLimits).toContain('editor_pie_project_world');
    expect(responseLimits).toContain('Limits.MaxStringChars = 2048');
  });

  it('requires explicit selection when several viewport clients are eligible', () => {
    expect(ops).toContain('multiple eligible PIE worlds; pass pie_instance from available_worlds');
    expect(ops).toContain('explicit_pie_instance');
    expect(cpp).toContain('available PIE worlds: [%s]');
  });
});
