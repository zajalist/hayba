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
import { UeToolError } from '../tool-executor.js';
import { pieAxisHandler } from './pie-axis.js';
import { pieClickWidgetHandler } from './pie-click-widget.js';
import { pieMouseHandler } from './pie-mouse.js';
import { piePressKeyHandler } from './pie-press-key.js';
import { pieScreenshotHandler } from './pie-screenshot.js';
import { pieTypeTextHandler } from './pie-type-text.js';
import { pieWidgetTreeHandler } from './pie-widget-tree.js';
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
  { name: 'pie_click_widget', cmd: 'editor_pie_click_widget', handler: pieClickWidgetHandler, args: { match: 'Start Game' } },
  { name: 'pie_widget_tree', cmd: 'editor_pie_widget_tree', handler: pieWidgetTreeHandler, args: {} },
  { name: 'pie_mouse', cmd: 'editor_pie_mouse', handler: pieMouseHandler, args: { x: 100, y: 200 } },
  { name: 'pie_press_key', cmd: 'editor_pie_press_key', handler: piePressKeyHandler, args: { key: 'SpaceBar' } },
  { name: 'pie_type_text', cmd: 'editor_pie_type_text', handler: pieTypeTextHandler, args: { text: 'hello' } },
  // NB: `key` is an axis KEY (Gamepad_LeftX), not an input-mapping axis name.
  { name: 'pie_axis', cmd: 'editor_pie_axis', handler: pieAxisHandler, args: { key: 'Gamepad_LeftX', value: 1 } },
  { name: 'pie_screenshot', cmd: 'editor_pie_screenshot', handler: pieScreenshotHandler, args: {} },
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
  // docs/HANDOFF-pie-input-tools-not-inserting-text.md). Nothing about the
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
  });

  it('records the plugin commands that have no TS wrapper', () => {
    // Not a failure — implemented-but-unwrapped capability is invisible to the
    // agent, so it is worth naming. Update this list when a wrapper is added.
    const wrapped = new Set(TOOLS.map((t) => t.cmd));
    const unwrapped = [...registered].filter((c) => !wrapped.has(c)).sort();
    expect(unwrapped).toEqual(['editor_pie_assert', 'editor_pie_wait_for']);
  });
});
