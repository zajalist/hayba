const test = require('node:test');
const assert = require('node:assert/strict');
const { LightingSession } = require('./lighting.cjs');

function fixture() {
  const lights = [
    { id: 'a', actor_id: 'A_1', label: 'A', intensity: 10 },
    { id: 'b', actor_id: 'B_2', label: 'B', intensity: 4 },
  ];
  const writes = [];
  const mcp = {
    async call(tool, args) {
      if (tool === 'lighting_set_intensity_checked') {
        writes.push(args);
        lights.find((l) => l.id === args.first).intensity = args.intensity;
      }
      return { map: '/Test', lights: structuredClone(lights) };
    },
  };
  return { session: new LightingSession(mcp, { messages: [] }, () => {}, 'test.uproject'), lights, writes, mcp };
}

test('decline only reads, approve and undo verify both lights, and stale approvals cannot replay', async () => {
  const { session, writes } = fixture();
  const r = await session.inspect('A', 'B');
  session.propose(r.id, 'b', 8);
  const stale = r.token;
  await session.decide('decline', stale);
  assert.equal(writes.length, 0);
  session.propose(r.id, 'b', 7);
  await assert.rejects(session.decide('approve', stale));
  await session.decide('approve', r.token);
  assert.deepEqual(
    r.observed.map((l) => l.intensity),
    [10, 7],
  );
  await session.decide('undo', r.token);
  assert.deepEqual(
    r.observed.map((l) => l.intensity),
    [10, 4],
  );
  assert.deepEqual(
    writes.map((w) => [w.first, w.expected, w.intensity, w.other_expected]),
    [
      ['b', 4, 7, 10],
      ['b', 7, 4, 10],
    ],
  );
});

test('changing the other light invalidates the proposal without writing', async () => {
  const { session, lights, writes } = fixture();
  const r = await session.inspect('A', 'B');
  session.propose(r.id, 'a', 20);
  lights[1].intensity = 9;
  await session.decide('approve', r.token);
  assert.equal(r.status, 'unverified');
  assert.equal(writes.length, 0);
  assert.equal(r.observed[1].intensity, 9);
});

test('a dropped write reply triggers observation, never an automatic replay', async () => {
  const { session, mcp, writes } = fixture();
  const original = mcp.call.bind(mcp);
  mcp.call = async (tool, args) => {
    const result = await original(tool, args);
    if (tool === 'lighting_set_intensity_checked') throw Error('Lost reply');
    return result;
  };
  const r = await session.inspect('A', 'B');
  session.propose(r.id, 'a', 20);
  await session.decide('approve', r.token);
  assert.equal(r.status, 'unverified');
  assert.deepEqual(
    r.observed.map((l) => l.intensity),
    [20, 4],
  );
  assert.equal(writes.length, 1);
});

test('automatic mode reports an editor-enforced review without applying or replaying it', async () => {
  const { session, mcp, writes } = fixture();
  const call = mcp.call.bind(mcp);
  let attempted = 0;
  mcp.call = async (name, args) => {
    if (name === 'lighting_set_intensity_checked') {
      attempted++;
      return { status: 'plan_mode_required', proposal_id: 'native-review' };
    }
    return call(name, args);
  };
  const record = await session.inspect('A', 'B');
  session.propose(record.id, 'a', 15);
  await session.decide('approve', record.token, true);
  assert.equal(attempted, 1);
  assert.equal(writes.length, 0);
  assert.throws(() => session.receipt('applied'), /Unreal Plan Mode/);
});
