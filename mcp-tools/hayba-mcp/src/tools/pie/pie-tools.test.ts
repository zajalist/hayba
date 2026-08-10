// PIE tool tests, driven through the ToolExecutor seam.
//
// These seven wrappers had no tests at all, which mattered more than usual:
// PIE input is the one surface where "did it work?" cannot be answered by
// reading state back, so a wrapper that sends the wrong command name or drops a
// parameter fails silently and looks like an engine bug. Diagnosing one of those
// by hand cost most of a session.
//
// Nothing here needs a running editor. The engine is scripted, so the failure
// modes that matter — UE refusing, UE lying, the socket dropping — are ordinary
// test cases rather than things you wait for.

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { scriptedUe, type ScriptedUe } from '../testing/scripted-ue.js';
import { NON_IDEMPOTENT, UeToolError } from '../tool-executor.js';
import { pieAxisHandler } from './pie-axis.js';
import { pieClickWidgetHandler } from './pie-click-widget.js';
import { pieMouseHandler } from './pie-mouse.js';
import { piePressKeyHandler } from './pie-press-key.js';
import { pieScreenshotHandler } from './pie-screenshot.js';
import { pieTypeTextHandler } from './pie-type-text.js';
import { pieSetTextHandler } from './pie-set-text.js';
import { pieWidgetTreeHandler } from './pie-widget-tree.js';
import { pieActorListHandler } from './pie-actor-list.js';
import { pieActorInspectHandler } from './pie-actor-inspect.js';
import { pieProjectWorldHandler } from './pie-project-world.js';
import { pieClickActorHandler } from './pie-click-actor.js';
import type { SessionManager, ToolHandler } from '../types.js';

// PIE wrappers ignore the session; a stub keeps the ToolHandler signature honest.
const session = {} as SessionManager;

let ue: ScriptedUe;
afterEach(() => ue?.restore());

function payload(r: { content: Array<{ text?: string }> }): Record<string, unknown> {
  return JSON.parse(r.content[0]!.text!) as Record<string, unknown>;
}

/** Each wrapper, the command it must send, and arguments that satisfy its schema. */
const TOOLS: Array<{ name: string; cmd: string; handler: ToolHandler; args: Record<string, unknown> }> = [
  {
    name: 'pie_click_widget',
    cmd: 'editor_pie_click_widget',
    handler: pieClickWidgetHandler,
    args: { match: 'Start Game' },
  },
  { name: 'pie_widget_tree', cmd: 'editor_pie_widget_tree', handler: pieWidgetTreeHandler, args: {} },
  { name: 'pie_mouse', cmd: 'editor_pie_mouse', handler: pieMouseHandler, args: { x: 100, y: 200 } },
  { name: 'pie_press_key', cmd: 'editor_pie_press_key', handler: piePressKeyHandler, args: { key: 'SpaceBar' } },
  { name: 'pie_type_text', cmd: 'editor_pie_type_text', handler: pieTypeTextHandler, args: { text: 'hello' } },
  {
    name: 'pie_set_text',
    cmd: 'editor_pie_set_text',
    handler: pieSetTextHandler,
    args: { text: 'hello', match: 'Username' },
  },
  // NB: `key` is an axis KEY (Gamepad_LeftX), not an input-mapping axis name.
  { name: 'pie_axis', cmd: 'editor_pie_axis', handler: pieAxisHandler, args: { key: 'Gamepad_LeftX', value: 1 } },
  { name: 'pie_screenshot', cmd: 'editor_pie_screenshot', handler: pieScreenshotHandler, args: {} },
  {
    name: 'pie_actor_list',
    cmd: 'editor_pie_actor_list',
    handler: pieActorListHandler,
    args: { class_filter: 'Road' },
  },
  {
    name: 'pie_actor_inspect',
    cmd: 'editor_pie_actor_inspect',
    handler: pieActorInspectHandler,
    args: { actor_path: '/Game/UEDPIE_0_Map.Map:PersistentLevel.Road_1' },
  },
  {
    name: 'pie_project_world',
    cmd: 'editor_pie_project_world',
    handler: pieProjectWorldHandler,
    args: { world_location: [1, 2, 3] },
  },
  {
    name: 'pie_click_actor',
    cmd: 'editor_pie_click_actor',
    handler: pieClickActorHandler,
    args: { actor_path: '/Game/UEDPIE_0_Map.Map:PersistentLevel.Road_1' },
  },
];

describe('every PIE wrapper reaches the command it claims', () => {
  // A wrapper pointed at a command name the plugin does not implement fails at
  // the transport layer, which reads as "the editor is broken" rather than
  // "this tool is misspelled".
  for (const t of TOOLS) {
    it(`${t.name} sends ${t.cmd}`, async () => {
      ue = scriptedUe().replies(t.cmd, { ok: true, sent: true });
      await t.handler(t.args, session);
      expect(ue.calls.map((c) => c.cmd)).toEqual([t.cmd]);
    });
  }
});

describe('arguments survive the trip', () => {
  it('click_widget forwards the match text verbatim', async () => {
    ue = scriptedUe().replies('editor_pie_click_widget', { ok: true, clicked: true });
    await pieClickWidgetHandler({ match: 'Start Game' }, session);
    expect(ue.paramsFor('editor_pie_click_widget')).toMatchObject({ match: 'Start Game' });
  });

  it('mouse forwards coordinates as numbers, not strings', async () => {
    // The C++ side reads these with TryGetNumberField; a stringified coordinate
    // is dropped and the click lands at 0,0.
    ue = scriptedUe().replies('editor_pie_mouse', { ok: true });
    await pieMouseHandler({ x: 640, y: 360 }, session);
    const p = ue.paramsFor('editor_pie_mouse');
    expect(typeof p.x).toBe('number');
    expect(typeof p.y).toBe('number');
  });

  it('type_text preserves text exactly, including spaces', async () => {
    ue = scriptedUe().replies('editor_pie_type_text', { ok: true, typed: 11 });
    await pieTypeTextHandler({ text: 'hello  world' }, session);
    expect(ue.paramsFor('editor_pie_type_text').text).toBe('hello  world');
  });

  it('drag forwards the destination and the step count', async () => {
    // A drag that arrives without to_x/to_y presses and never moves, which reads
    // downstream as "the widget ignored the drag".
    ue = scriptedUe().replies('editor_pie_mouse', { ok: true });
    await pieMouseHandler({ action: 'drag', x: 1424, y: 700, to_x: 1424, to_y: 1000, steps: 16 }, session);
    expect(ue.paramsFor('editor_pie_mouse')).toMatchObject({
      action: 'drag',
      to_x: 1424,
      to_y: 1000,
      steps: 16,
    });
  });

  it('scroll forwards a cursor position, so the wheel has a target', async () => {
    // A wheel is delivered to whatever is under the cursor. Without x/y it lands
    // wherever the previous call left the pointer, which is not something the
    // caller can reason about — and was one reason wheel results were unreadable.
    ue = scriptedUe().replies('editor_pie_mouse', { ok: true, handled_by: 'slate' });
    await pieMouseHandler({ action: 'scroll', x: 1200, y: 800, delta: -3 }, session);
    expect(ue.paramsFor('editor_pie_mouse')).toMatchObject({
      action: 'scroll',
      x: 1200,
      y: 800,
      delta: -3,
    });
  });
});

describe('pie_screenshot check_only polls the file the caller named', () => {
  it('forwards filename on a check_only poll', async () => {
    ue = scriptedUe().replies('editor_pie_screenshot', {
      filename: 'D:/Saved/HaybaPIE_x.png',
      captured: true,
      requested: false,
    });
    await pieScreenshotHandler({ filename: 'D:/Saved/HaybaPIE_x.png', check_only: true }, session);
    expect(ue.paramsFor('editor_pie_screenshot')).toMatchObject({
      filename: 'D:/Saved/HaybaPIE_x.png',
      check_only: true,
    });
  });

  it('accepts `path` as an alias and forwards it as filename', async () => {
    // The object_* tools call the same idea `path`; stripping it silently made
    // check_only polls target a fresh timestamped file that never existed.
    ue = scriptedUe().replies('editor_pie_screenshot', { captured: true, requested: false });
    await pieScreenshotHandler({ path: 'D:/Saved/HaybaPIE_x.png', check_only: true }, session);
    const p = ue.paramsFor('editor_pie_screenshot');
    expect(p.filename).toBe('D:/Saved/HaybaPIE_x.png');
    expect(p).not.toHaveProperty('path');
  });

  it('rejects unknown parameter names instead of stripping them', async () => {
    ue = scriptedUe().replies('editor_pie_screenshot', { ok: true });
    const r = await pieScreenshotHandler({ file: 'D:/Saved/HaybaPIE_x.png', check_only: true }, session);
    expect(r.isError).toBe(true);
    expect(ue.calls).toHaveLength(0);
  });
});

describe('bad arguments are rejected before reaching UE', () => {
  it('click_widget refuses an empty match instead of clicking something arbitrary', async () => {
    ue = scriptedUe().replies('editor_pie_click_widget', { ok: true });
    const r = await pieClickWidgetHandler({ match: '' }, session);
    expect(r.isError).toBe(true);
    expect(ue.calls).toHaveLength(0);
  });

  it('press_key refuses a missing key', async () => {
    ue = scriptedUe().replies('editor_pie_press_key', { ok: true });
    const r = await piePressKeyHandler({}, session);
    expect(r.isError).toBe(true);
    expect(ue.calls).toHaveLength(0);
  });

  it('PIE actor inspection requires exactly one reference', async () => {
    ue = scriptedUe().replies('editor_pie_actor_inspect', { ok: true });
    expect((await pieActorInspectHandler({}, session)).isError).toBe(true);
    expect((await pieActorInspectHandler({ actor_id: 'Road_1', actor_label: 'Road' }, session)).isError).toBe(true);
    expect(ue.calls).toHaveLength(0);
  });

  it('world projection refuses cross-target ambiguity', async () => {
    ue = scriptedUe().replies('editor_pie_project_world', { ok: true });
    const r = await pieProjectWorldHandler({ actor_id: 'Road_1', world_location: [0, 0, 0] }, session);
    expect(r.isError).toBe(true);
    expect(ue.calls).toHaveLength(0);
  });

  it('actor interaction requires one exact actor target and rejects irrelevant fields', async () => {
    ue = scriptedUe().replies('editor_pie_click_actor', { ok: true });
    expect((await pieClickActorHandler({}, session)).isError).toBe(true);
    expect((await pieClickActorHandler({ actor_id: 'Road_1', actor_label: 'Road' }, session)).isError).toBe(true);
    expect(
      (
        await pieClickActorHandler(
          {
            actor_id: 'Road_1',
            world_location: [0, 0, 0],
          },
          session,
        )
      ).isError,
    ).toBe(true);
    expect(ue.calls).toHaveLength(0);
  });

  it('runtime list enforces response caps and rejects unknown fields', async () => {
    ue = scriptedUe().replies('editor_pie_actor_list', { actors: [] });
    expect((await pieActorListHandler({ limit: 51 }, session)).isError).toBe(true);
    expect((await pieActorListHandler({ world: 'editor' }, session)).isError).toBe(true);
    expect(ue.calls).toHaveLength(0);
  });
});

describe('runtime scene grounding forwards typed defaults and exact identifiers', () => {
  it('list supplies bounded paging defaults', async () => {
    ue = scriptedUe().replies('editor_pie_actor_list', { actors: [], total_matched: 0 });
    await pieActorListHandler({ name_filter: 'Road' }, session);
    expect(ue.paramsFor('editor_pie_actor_list')).toMatchObject({ name_filter: 'Road', offset: 0, limit: 50 });
  });

  it('inspect preserves a PIE path and component page', async () => {
    ue = scriptedUe().replies('editor_pie_actor_inspect', { actor: {}, components: [] });
    const actorPath = '/Game/UEDPIE_1_WarRoom.WarRoom:PersistentLevel.BP_RoadSpline_C_7';
    await pieActorInspectHandler(
      { pie_instance: 1, actor_path: actorPath, component_offset: 50, component_limit: 50 },
      session,
    );
    expect(ue.paramsFor('editor_pie_actor_inspect')).toMatchObject({
      pie_instance: 1,
      actor_path: actorPath,
      component_offset: 50,
      component_limit: 50,
    });
  });

  it('project requests visibility evidence by default', async () => {
    ue = scriptedUe().replies('editor_pie_project_world', { viewport: {}, absolute: {}, visibility_hit: {} });
    await pieProjectWorldHandler({ actor_id: 'Road_1' }, session);
    expect(ue.paramsFor('editor_pie_project_world')).toMatchObject({
      actor_id: 'Road_1',
      player_index: 0,
      trace_visibility: true,
    });
    expect(ue.paramsFor('editor_pie_project_world')).not.toHaveProperty('sample');
  });

  it('actor interaction forwards exact routing defaults and is retry-unsafe', async () => {
    ue = scriptedUe().replies('editor_pie_click_actor', {
      dispatch: { pressed: true, released: true },
    });
    const actorPath = '/Game/UEDPIE_1_WarRoom.WarRoom:PersistentLevel.BP_RoadSpline_C_7';
    await pieClickActorHandler({ pie_instance: 1, actor_path: actorPath }, session);
    expect(ue.paramsFor('editor_pie_click_actor')).toEqual({
      pie_instance: 1,
      actor_path: actorPath,
      player_index: 0,
      action: 'click',
    });
    expect(NON_IDEMPOTENT.has('editor_pie_click_actor')).toBe(true);
  });

  it('actor hover and invalid sample combinations fail closed before UE dispatch', async () => {
    ue = scriptedUe().replies('editor_pie_click_actor', { dispatch: { pressed: true } });
    expect(
      (
        await pieClickActorHandler(
          {
            actor_id: 'Road_1',
            component_name: 'RoadCollision',
            sample: 'component_location',
            action: 'hover',
          },
          session,
        )
      ).isError,
    ).toBe(true);
    expect(ue.calls).toHaveLength(0);

    expect(
      (
        await pieClickActorHandler(
          { actor_id: 'Road_1', component_name: 'RoadCollision', sample: 'actor_location' },
          session,
        )
      ).isError,
    ).toBe(true);
    expect(ue.calls).toHaveLength(0);
  });

  it('rejects semantically irrelevant sample combinations', async () => {
    ue = scriptedUe().replies('editor_pie_project_world', { ok: true });
    expect(
      (await pieProjectWorldHandler({ world_location: [0, 0, 0], sample: 'bounds_origin' }, session)).isError,
    ).toBe(true);
    expect(
      (
        await pieProjectWorldHandler(
          { actor_id: 'Road_1', component_name: 'Spline', sample: 'actor_location' },
          session,
        )
      ).isError,
    ).toBe(true);
    expect(ue.calls).toHaveLength(0);
  });
});

describe('what happens when UE does not cooperate', () => {
  it('surfaces a refusal as a UeToolError rather than a success', async () => {
    ue = scriptedUe().fails('editor_pie_click_widget', 'PIE is not running');
    await expect(pieClickWidgetHandler({ match: 'Start' }, session)).rejects.toBeInstanceOf(UeToolError);
  });

  it('surfaces a dropped socket rather than hanging', async () => {
    ue = scriptedUe().disconnects('editor_pie_widget_tree');
    await expect(pieWidgetTreeHandler({}, session)).rejects.toBeInstanceOf(UeToolError);
  });

  it('passes a bare ok through unchanged — the wrapper does not invent evidence', async () => {
    // The wrapper must not dress this up. Naming it as unverified is the
    // registrar's job (response-evidence), and that split is deliberate: a
    // wrapper that fabricated detail here would defeat the contract.
    ue = scriptedUe().silentlySucceeds('editor_pie_click_widget');
    const r = await pieClickWidgetHandler({ match: 'Start' }, session);
    expect(payload(r)).toEqual({});
    expect(r.isError).toBeFalsy();
  });

  it('reports a click that matched nothing, rather than implying success', async () => {
    ue = scriptedUe().replies('editor_pie_click_widget', { ok: false, candidates: 0, matched: null });
    const r = await pieClickWidgetHandler({ match: 'No Such Button' }, session);
    expect(payload(r)).toMatchObject({ candidates: 0 });
  });
});

describe('cross-language contract with the C++ handler', () => {
  // The wrapper and the plugin are separate languages in separate build systems,
  // so nothing but a test stops them drifting. This is the check that would have
  // caught a wrapper pointed at a command the plugin never registered.
  const here = fileURLToPath(new URL('.', import.meta.url));
  const cpp = readFileSync(
    join(here, '../../../../../unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPPIEHandler.cpp'),
    'utf8',
  );
  const registered = new Set([...cpp.matchAll(/TEXT\("(editor_pie_[a-z_]+)"\)/g)].map((m) => m[1]!));

  it('the C++ handler was found and declares commands', () => {
    // Guards the test itself: a bad path would otherwise make every case below
    // vacuously pass.
    expect(registered.size).toBeGreaterThan(3);
  });

  for (const t of TOOLS) {
    it(`${t.cmd} is implemented in the plugin`, () => {
      expect(registered.has(t.cmd)).toBe(true);
    });
  }

  // This file has now shipped the same bug twice: input dispatched through
  // UGameViewportClient, which feeds the game input pipeline and never consults
  // the Slate widget tree, so focused UMG widgets never see it. It was fixed for
  // the mouse (clicks did nothing), then found again on the keyboard
  // (editor_pie_type_text reported characters_sent and inserted nothing —
  // docs/handoffs/HANDOFF-pie-input-tools-not-inserting-text.md). Nothing about the
  // viewport call looks wrong at the call site, which is why it keeps coming
  // back, and why this is a test rather than a comment.
  describe('UI input is routed through Slate, not the game viewport', () => {
    it('delivers characters via ProcessKeyCharEvent', () => {
      expect(cpp).toContain('ProcessKeyCharEvent');
    });

    it('delivers keys via ProcessKeyDownEvent/ProcessKeyUpEvent', () => {
      expect(cpp).toContain('ProcessKeyDownEvent');
      expect(cpp).toContain('ProcessKeyUpEvent');
    });

    it('delivers mouse buttons via ProcessMouseButtonDownEvent', () => {
      expect(cpp).toContain('ProcessMouseButtonDownEvent');
    });

    it('reports what the UI accepted, not just what was sent', () => {
      // characters_sent / dispatched alone are the silent-lie shape: they say
      // "we tried". These two say whether it landed.
      expect(cpp).toContain('characters_accepted_by_ui');
      expect(cpp).toContain('handled_by_ui');
    });

    it('sends the companion character for keys Slate handles via OnKeyChar', () => {
      // FSlateEditableTextLayout tests for '\b' and '\r', not the key event, so
      // a key-down-only BackSpace reports success and erases nothing.
      expect(cpp).toContain("Companion = TEXT('\\b')");
      expect(cpp).toContain("Companion = TEXT('\\r')");
    });

    it('delivers the mouse wheel via ProcessMouseWheelOrGestureEvent', () => {
      // Third instance of the same bug, on the third input device: the wheel was
      // UGameViewportClient::InputKey(MouseWheelAxis), which no SWidget listens
      // to. SScrollBox::OnMouseWheel therefore could not fire, and two critics
      // reported a working ScrollBox as dead because they measured it with a
      // wheel that reached nothing.
      expect(cpp).toContain('ProcessMouseWheelOrGestureEvent');
    });

    it('only falls back to the game viewport when Slate declined the wheel', () => {
      // Sending both would double-apply every notch, because Slate's own route
      // already reaches the viewport through SViewport::OnMouseWheel.
      expect(cpp).toMatch(/if\s*\(!bSlateHandled\s*&&\s*Client->Viewport\)/);
    });
  });

  // ── capture + delta: the second half of the same defect ────────────────────
  //
  // A held gesture (scrollbar thumb, slider, splitter, marquee, drag-and-drop)
  // is consumed off the MOVE events between the press and the release, and
  // SScrollBar::OnMouseMove — the reference consumer — reads exactly two things:
  //
  //     if (this->HasMouseCapture())
  //         if (!MouseEvent.GetCursorDelta().IsZero()) ...
  //
  // The harness supplied neither. Capture came free once the press was routed
  // through Slate; the delta did not, and the reason is subtle enough that it
  // will be "simplified" back if nothing guards it: FSlateApplication::SetCursorPos
  // ends in FSlateUser::UpdatePointerPosition, which writes the destination to
  // BOTH the current and the previous pointer position. Read the position after
  // moving and the delta is always (0,0).
  describe('synthetic moves carry a real cursor delta and the held button', () => {
    // lastIndexOf, not indexOf: both helpers are forward-declared near the top
    // of the anonymous namespace, so the first hit is a declaration and the
    // slice would come back empty (and every assertion below would pass
    // vacuously — which is why 'the move helper was found' exists).
    const moveFn = cpp.slice(
      cpp.lastIndexOf('FVector2D SendPointerMoveTo(const FVector2D& AbsTo)'),
      cpp.lastIndexOf('void SendHoverRefresh()'),
    );

    it('the move helper was found', () => {
      // Guards the slice: a rename would otherwise make every case below pass
      // against an empty string.
      expect(moveFn.length).toBeGreaterThan(200);
      expect(moveFn).toContain('ProcessMouseMoveEvent');
    });

    it('reads the origin BEFORE moving the cursor', () => {
      const read = moveFn.indexOf('Slate.GetCursorPos()');
      const move = moveFn.indexOf('Slate.SetCursorPos(');
      expect(read).toBeGreaterThan(-1);
      expect(move).toBeGreaterThan(-1);
      expect(read).toBeLessThan(move);
    });

    it('never builds a move from GetLastCursorPos', () => {
      // THE REGRESSION, stated exactly. After a SetCursorPos, GetLastCursorPos()
      // is the destination — so this pair always yields a zero delta.
      expect(moveFn).not.toContain('GetLastCursorPos');
    });

    it('carries Slate pressed buttons rather than an empty set', () => {
      // SScrollBox gates right-click drag scrolling on
      // MouseEvent.IsMouseButtonDown(EKeys::RightMouseButton); an empty set here
      // makes that gesture impossible no matter how good the delta is.
      expect(moveFn).toContain('Slate.GetPressedMouseButtons()');
      expect(moveFn).not.toContain('TSet<FKey>()');
    });

    it('reports the two facts a caller needs to tell a harness fault from a widget fault', () => {
      expect(cpp).toContain('cursor_delta_x');
      expect(cpp).toContain('moves_delivered');
      expect(cpp).toContain('mouse_captor');
    });
  });

  it('records the plugin commands that have no TS wrapper', () => {
    // Not a failure — implemented-but-unwrapped capability is invisible to the
    // agent, so it is worth naming. Update this list when a wrapper is added.
    const wrapped = new Set(TOOLS.map((t) => t.cmd));
    const unwrapped = [...registered].filter((c) => !wrapped.has(c)).sort();
    expect(unwrapped).toEqual(['editor_pie_assert', 'editor_pie_wait_for']);
  });
});
