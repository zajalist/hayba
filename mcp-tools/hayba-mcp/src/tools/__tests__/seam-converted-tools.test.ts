/**
 * The five tool handlers that used to hold their own TCP client.
 *
 * Each called `ensureConnected()` then `client.send(...)` directly, which put
 * them outside the ToolExecutor seam: no shared timeout policy, no retry rules,
 * no non-idempotent protection, and — the reason they had zero tests between
 * them — no way to exercise them without a live editor.
 *
 * These tests exist mostly to pin the behaviour that was easy to lose in the
 * conversion. `executeCommand` THROWS where the old code inspected `resp.ok`,
 * so anything the old !ok branch did specially had to move into a catch. Two
 * cases mattered: python_run's tier-3 sandbox message (which lives in the
 * failure payload, not the message) and the prompt tools' distinct error
 * bodies.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { scriptedUe, type ScriptedUe } from '../testing/scripted-ue.js';
import { sceneValidatePhysicsHandler } from '../scene/scene-validate-physics.js';
import { haybaGetUserResponseHandler } from '../prompts/hayba-get-user-response.js';
import { haybaRequestInputHandler } from '../prompts/hayba-request-input.js';
import { pythonRunHandler } from '../python/python-run.js';

let ue: ScriptedUe | undefined;

afterEach(() => {
  ue?.restore();
  ue = undefined;
});

/** First text block of a tool result. */
function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content.find((c) => c.type === 'text')?.text ?? '';
}

describe('scene_validate_physics', () => {
  it('sends the validated args through the seam', async () => {
    ue = scriptedUe().replies('scene_validate_physics', { floating: [], count: 0 });
    await sceneValidatePhysicsHandler({ deep_check: true }, {} as never);
    expect(ue.paramsFor('scene_validate_physics')).toMatchObject({ deep_check: true });
  });

  it('appends the deep-check note only when UE asks for it', async () => {
    ue = scriptedUe().replies('scene_validate_physics', { deep_check_required: true });
    const withNote = await sceneValidatePhysicsHandler({ deep_check: true }, {} as never);
    expect(textOf(withNote)).toContain('visual sidecar');

    ue.restore();
    ue = scriptedUe().replies('scene_validate_physics', { deep_check_required: true });
    // deep_check not requested — the note would be advice about a thing the
    // caller did not ask for.
    const withoutNote = await sceneValidatePhysicsHandler({}, {} as never);
    expect(textOf(withoutNote)).not.toContain('visual sidecar');
  });

  it('reports a UE failure as an error rather than an empty success', async () => {
    ue = scriptedUe().fails('scene_validate_physics', 'no world');
    const r = await sceneValidatePhysicsHandler({}, {} as never);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('no world');
  });

  it('rejects a malformed window without contacting UE', async () => {
    ue = scriptedUe();
    const r = await sceneValidatePhysicsHandler({ window: { min: [0, 0], max: [1, 1, 1] } }, {} as never);
    expect(r.isError).toBe(true);
    expect(ue.calls).toEqual([]);
  });
});

describe('python_run', () => {
  it('preserves the tier-3 sandbox message, which lives in the failure payload', async () => {
    // The old code read resp.data.tier off a non-ok response. The seam throws,
    // so this only still works because the thrown error carries uePayload —
    // the exact detail a conversion loses silently, turning an actionable
    // "here is the setting to change" into a bare error string.
    ue = scriptedUe().failsWithData('python_run', 'open() denied', { tier: 3 });
    const r = await pythonRunHandler({ script: 'open("/etc/passwd")' }, {} as never);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('bAllowUnsafePython');
    expect(textOf(r)).toContain('open() denied');
  });

  it('reports an ordinary failure without the tier-3 advice', async () => {
    ue = scriptedUe().fails('python_run', 'NameError: foo');
    const r = await pythonRunHandler({ script: 'foo' }, {} as never);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('NameError');
    expect(textOf(r)).not.toContain('bAllowUnsafePython');
  });

  it('returns the payload on success', async () => {
    ue = scriptedUe().replies('python_run', { stdout: 'hello', result: null });
    const r = await pythonRunHandler({ script: 'print("hello")' }, {} as never);
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('hello');
  });
});

describe('prompt tools', () => {
  it('hayba_request_input reports pushed and echoes the generated prompt_id', async () => {
    ue = scriptedUe().replies('hayba_request_input', {});
    const r = await haybaRequestInputHandler({ kind: 'approve', title: 'Proceed?' }, {} as never);
    const body = JSON.parse(textOf(r)) as { status: string; prompt_id: string };
    expect(body.status).toBe('pushed');
    // A caller needs the id to poll for the answer; generating one and not
    // returning it would make the tool unusable.
    expect(body.prompt_id).toBeTruthy();
    expect(ue.paramsFor('hayba_request_input').prompt_id).toBe(body.prompt_id);
  });

  it('hayba_request_input reports push_failed when UE refuses', async () => {
    ue = scriptedUe().fails('hayba_request_input', 'panel closed');
    const r = await haybaRequestInputHandler({ kind: 'approve', title: 'Proceed?' }, {} as never);
    expect(r.isError).toBe(true);
    expect(JSON.parse(textOf(r)).status).toBe('push_failed');
  });

  it('hayba_get_user_response gives the wait a longer timeout than it waits for', async () => {
    // The TCP deadline must outlive the UE-side wait, or the tool times out on
    // every successful long poll.
    ue = scriptedUe().replies('hayba_get_user_response', { status: 'answered', value: 'yes' });
    const r = await haybaGetUserResponseHandler({ prompt_id: 'p1', wait_ms: 30_000 }, {} as never);
    expect(JSON.parse(textOf(r)).status).toBe('answered');
    expect(ue.paramsFor('hayba_get_user_response')).toMatchObject({ prompt_id: 'p1', wait_ms: 30_000 });
  });

  it('hayba_get_user_response reports unknown status on failure, keeping the prompt_id', async () => {
    ue = scriptedUe().fails('hayba_get_user_response', 'no such prompt');
    const r = await haybaGetUserResponseHandler({ prompt_id: 'p1' }, {} as never);
    expect(r.isError).toBe(true);
    const body = JSON.parse(textOf(r)) as { status: string; prompt_id: string };
    expect(body.status).toBe('unknown');
    expect(body.prompt_id).toBe('p1');
  });
});
