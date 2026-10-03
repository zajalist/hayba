import { describe, expect, it } from 'vitest';
import { NON_IDEMPOTENT, executeCommand, type Sender } from './tool-executor.js';

const actorEdits = [
  ['actor_transform', { actor_id: 'TestActor', location: [1, 2, 3] }],
  ['actor_set_properties', { actor_id: 'TestActor', properties: { TestValue: 42 } }],
  ['actor_tag', { actor_id: 'TestActor', add: ['test'] }],
  ['actor_set_visibility', { actor_id: 'TestActor', visible: false }],
] as const;

describe('actor edit retry policy', () => {
  it.each(actorEdits)('%s leaves an unknown outcome after a lost reply without replaying the edit', async (command, params) => {
    expect(NON_IDEMPOTENT.has(command)).toBe(true);

    let editorMutations = 0;
    const sender: Sender = async (sentCommand, sentParams) => {
      expect(sentCommand).toBe(command);
      expect(sentParams).toEqual(params);
      editorMutations++;
      // The editor applied the change, but the TCP response never arrived.
      throw new Error('ECONNRESET after dispatch');
    };

    await expect(executeCommand(command, params, { sender })).rejects.toMatchObject({
      name: 'UeToolError',
      code: 'transport',
      message: 'ECONNRESET after dispatch',
    });
    expect(editorMutations).toBe(1);
  });
});
