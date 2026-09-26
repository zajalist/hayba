import { afterEach, describe, expect, it } from 'vitest';
import { scriptedUe, type ScriptedUe } from '../testing/scripted-ue.js';
import { uiBindEventHandler } from './ui-bind-event.js';
import { STANDARD_DESCRIPTORS } from '../index.js';

let ue: ScriptedUe | undefined;
afterEach(() => {
  ue?.restore();
  ue = undefined;
});

function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content.find((c) => c.type === 'text')?.text ?? '';
}

describe('ui_bind_event', () => {
  it('asks the plugin to bind the named widget event on the named blueprint', async () => {
    ue = scriptedUe().replies('blueprint_add_bound_event', {
      node_id: 'B1', already_existed: false, verified: true, pins: [],
    });
    const r = await uiBindEventHandler(
      { widget_blueprint_path: '/Game/UI/WBP_Title', widget_name: 'StartButton', event_name: 'OnClicked' },
      {} as never,
    );
    expect(r.isError).toBeFalsy();
    // The wire command is generic (widgets AND components), so its params say
    // path/target — sending the UI-shaped names would be silently unread.
    expect(ue.paramsFor('blueprint_add_bound_event')).toEqual({
      path: '/Game/UI/WBP_Title', target: 'StartButton', event_name: 'OnClicked',
    });
    expect(textOf(r)).toContain('B1');
  });

  it('forwards a graph and position only when the caller gave them', async () => {
    ue = scriptedUe().replies('blueprint_add_bound_event', { node_id: 'B2', verified: true, pins: [] });
    await uiBindEventHandler(
      { widget_blueprint_path: '/Game/UI/W', widget_name: 'Quit', event_name: 'OnClicked', graph_name: 'EventGraph', x: 400, y: -80 },
      {} as never,
    );
    expect(ue.paramsFor('blueprint_add_bound_event')).toEqual({
      path: '/Game/UI/W', target: 'Quit', event_name: 'OnClicked', graph_name: 'EventGraph', x: 400, y: -80,
    });
  });

  it('refuses a call with no widget name without contacting UE', async () => {
    ue = scriptedUe();
    const r = await uiBindEventHandler(
      { widget_blueprint_path: '/Game/UI/W', widget_name: '', event_name: 'OnClicked' },
      {} as never,
    );
    expect(r.isError).toBe(true);
    expect(ue.calls).toEqual([]);
  });

  it('passes the plugin refusal through, naming the events that do exist', async () => {
    ue = scriptedUe().fails(
      'blueprint_add_bound_event',
      "blueprint_add_bound_event: 'Button' has no event 'OnClik'. Bindable events: OnClicked OnPressed OnReleased OnHovered OnUnhovered",
    );
    await expect(
      uiBindEventHandler({ widget_blueprint_path: '/Game/UI/W', widget_name: 'Start', event_name: 'OnClik' }, {} as never),
    ).rejects.toThrow(/OnClicked OnPressed/);
  });

  it('is registered as a UI tool that changes the asset', () => {
    const d = STANDARD_DESCRIPTORS.find((x) => x.name === 'ui_bind_event');
    expect(d, 'ui_bind_event is not registered').toBeDefined();
    expect(d!.meta?.effects).toContain('modifies_asset');
    // Binding restructures the graph and re-runs the skeleton compile, which the
    // 2s low-cost ceiling does not reliably cover on a real widget.
    expect(d!.cost).toBe('medium');
  });
});
