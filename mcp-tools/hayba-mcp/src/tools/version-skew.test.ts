import { describe, it, expect } from 'vitest';
import { isUnknownCommand, explainUnknownCommand } from './version-skew.js';
import { executeCommand, resetPeerProtocol } from './tool-executor.js';
import type { Sender } from './tool-executor.js';
import { HAYBA_PROTOCOL_VERSION } from '../protocol-version.js';

describe('isUnknownCommand', () => {
  it('matches the router spelling', () => {
    expect(isUnknownCommand('Unknown command: foliage_scatter_paint. If this command…')).toBe(true);
  });

  it('matches the per-handler spelling', () => {
    // Both are real and they differ in case and shape, which is exactly how a
    // narrower matcher would miss half the cases in production.
    expect(isUnknownCommand('ActorHandler: unknown command actor_teleport')).toBe(true);
  });

  it('does not match unrelated failures', () => {
    expect(isUnknownCommand('missing package_path')).toBe(false);
    expect(isUnknownCommand('the command timed out')).toBe(false);
  });
});

describe('explainUnknownCommand', () => {
  it('blames the version when the plugin is behind', () => {
    const r = explainUnknownCommand('foliage_scatter_paint', 'Unknown command: foliage_scatter_paint', 0);
    expect(r.versionGap).toBe(true);
    expect(r.message).toContain('Update the plugin');
    expect(r.message).toContain('hayba-cli doctor');
  });

  it('blames the SERVER when the plugin is ahead', () => {
    // "update Hayba" is useless when there are two things to update and only
    // one of them is wrong.
    const r = explainUnknownCommand('x', 'Unknown command: x', HAYBA_PROTOCOL_VERSION + 1);
    expect(r.versionGap).toBe(true);
    expect(r.message).toContain('npm server');
  });

  it('treats a silent plugin as a gap, because it is one', () => {
    const r = explainUnknownCommand('x', 'Unknown command: x', null);
    expect(r.versionGap).toBe(true);
    expect(r.message).toContain('predates this check');
  });

  it('does NOT invent a version story when the versions match', () => {
    // The important negative case. A matched pair failing here means the
    // command name is wrong; blaming the version sends someone to reinstall a
    // perfectly good plugin.
    const r = explainUnknownCommand('actor_teleprot', 'Unknown command: actor_teleprot', HAYBA_PROTOCOL_VERSION);
    expect(r.versionGap).toBe(false);
    expect(r.message).toContain('not a version gap');
    expect(r.message).toContain('actor_teleprot');
    expect(r.message).not.toContain('Update the plugin');
  });

  it('keeps the original error in both branches', () => {
    // Never swallow what the editor actually said -- the reframing is a guess
    // about cause, and the raw text is the evidence.
    const gap = explainUnknownCommand('x', 'RAW-UE-TEXT', 0);
    const noGap = explainUnknownCommand('x', 'RAW-UE-TEXT', HAYBA_PROTOCOL_VERSION);
    expect(gap.message).toContain('RAW-UE-TEXT');
    expect(noGap.message).toContain('RAW-UE-TEXT');
  });

  it('points at a discovery route, not just a complaint', () => {
    const r = explainUnknownCommand('x', 'Unknown command: x', HAYBA_PROTOCOL_VERSION);
    expect(r.message).toMatch(/list_tool_categories|CAPABILITIES/);
  });
});

describe('wired into executeCommand', () => {
  // These exist because the unit tests above all PASSED while the feature was
  // broken in production. They supply the protocol version directly, so they
  // could not see that the executor asked for it with a command name the
  // plugin does not route (`hayba_check_ue_status` -- the TypeScript tool
  // name, not the wire command). The probe always failed, the version always
  // came back null, and every unknown command was reported as a version gap
  // on a healthy install.
  //
  // So: assert on what the executor SENDS, not only on what it concludes.

  const senderThatKnowsState = (protocolVersion: number | null) => {
    const seen: string[] = [];
    const send: Sender = async (cmd) => {
      seen.push(cmd);
      if (cmd === 'editor_get_state') {
        return {
          id: 't', ok: true,
          data: protocolVersion === null ? {} : { protocol_version: protocolVersion },
        };
      }
      return { id: 't', ok: false, error: `Unknown command: ${cmd}` };
    };
    return { send, seen };
  };

  it('asks the editor with the WIRE command name', async () => {
    const { send, seen } = senderThatKnowsState(1);
    resetPeerProtocol();
    await expect(executeCommand('nope_not_real', {}, { sender: send })).rejects.toThrow();
    expect(seen).toContain('editor_get_state');
    expect(seen).not.toContain('hayba_check_ue_status');
  });

  it('does not claim a version gap when the editor reports a matching version', async () => {
    const { send } = senderThatKnowsState(HAYBA_PROTOCOL_VERSION);
    resetPeerProtocol();
    await expect(executeCommand('nope_not_real', {}, { sender: send }))
      .rejects.toThrow(/not a version gap/);
  });

  it('claims a version gap when the editor really is behind', async () => {
    const { send } = senderThatKnowsState(HAYBA_PROTOCOL_VERSION - 1);
    resetPeerProtocol();
    await expect(executeCommand('nope_not_real', {}, { sender: send }))
      .rejects.toThrow(/Update the plugin/);
  });

  it('asks only once across repeated failures', async () => {
    // This runs on an error path; probing on every failure would turn one bad
    // command into a stream of extra round-trips into a possibly-busy editor.
    const { send, seen } = senderThatKnowsState(HAYBA_PROTOCOL_VERSION);
    resetPeerProtocol();
    await expect(executeCommand('nope_a', {}, { sender: send })).rejects.toThrow();
    await expect(executeCommand('nope_b', {}, { sender: send })).rejects.toThrow();
    expect(seen.filter((c) => c === 'editor_get_state')).toHaveLength(1);
  });

  it('leaves ordinary failures completely alone', async () => {
    const send: Sender = async () => ({ id: 't', ok: false, error: 'missing package_path' });
    resetPeerProtocol();
    await expect(executeCommand('data_set', {}, { sender: send }))
      .rejects.toThrow('missing package_path');
  });
});
