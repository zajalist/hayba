const test = require('node:test');
const assert = require('node:assert/strict');
const { newChat, runTurn } = require('./session.cjs');
test('stream, interruption and retry keep only complete turns in provider context', async () => {
  const chat = newChat();
  const signal = new AbortController().signal;
  let sent;
  const client = {
    async *stream({ messages }) {
      sent = messages;
      yield { type: 'text_delta', text: 'hello' };
      yield { type: 'done', response: { stopReason: 'end_turn' } };
    },
  };
  await runTurn(chat, 'first', client, signal, () => {});
  assert.equal(chat.messages[1].text, 'hello');
  await runTurn(
    chat,
    'again',
    {
      async *stream() {
        yield { type: 'text_delta', text: 'partial' };
      },
    },
    signal,
    () => {},
  );
  assert.equal(chat.draft, 'again');
  assert.equal(chat.messages[3].notice, true);
  await runTurn(chat, 'retry', client, signal, () => {});
  assert.deepEqual(
    sent.map((m) => m.content),
    ['first', 'hello', 'retry'],
  );
});

test('a level tool failure reaches the provider as an error without inventing a scene', async () => {
  const chat = newChat();
  let result;
  const client = {
    async *stream({ messages }) {
      if (messages.at(-1).role === 'user' && typeof messages.at(-1).content === 'string') {
        yield { type: 'done', response: { stopReason: 'tool_use', toolCalls: [{ id: 'lookup', name: 'level_get_info', input: {} }] } };
        return;
      }
      result = messages.at(-1).content[0];
      yield { type: 'done', response: { stopReason: 'end_turn', content: 'Please open the editor.' } };
    },
  };
  await runTurn(
    chat,
    'Which level is open?',
    client,
    new AbortController().signal,
    () => {},
    async () => {
      throw Error('offline');
    },
  );
  assert.equal(result.is_error, true);
  assert.equal(result.tool_use_id, 'lookup');
  assert.deepEqual(chat.messages.at(-1).levelRead, { status: 'unavailable' });
  assert.equal(chat.messages.at(-1).text, 'Please open the editor.');
});

test('the transcript records the level read even if the provider reply fails later', async () => {
  const metadata = { map_name: 'Arena', package_path: '/Game/Arena', actor_count: 0, is_pie_running: false };
  const chat = newChat();
  const seen = [];
  const client = {
    async *stream({ messages }) {
      if (typeof messages.at(-1).content === 'string') {
        yield { type: 'done', response: { stopReason: 'tool_use', toolCalls: [{ id: 'lookup', name: 'level_get_info', input: {} }] } };
        return;
      }
      throw Error('Connection closed');
    },
  };
  await runTurn(
    chat,
    'Inspect',
    client,
    new AbortController().signal,
    () => seen.push(chat.messages.at(-1).levelRead?.status),
    async () => JSON.stringify(metadata),
  );
  assert.ok(seen.includes('reading'));
  assert.deepEqual(chat.messages.at(-1).levelRead, { status: 'complete', metadata });
  assert.equal(chat.messages.at(-1).notice, true);
});

test('a streamed turn chains tools and only offers undo in an automatic project', async () => {
  for (const automatic of [false, true]) {
    const chat = newChat();
    let round = 0;
    const client = { async *stream({ tools, messages }) {
      assert.equal(tools.some((t) => t.name === 'undo_light_intensity'), automatic);
      if (round < 2) {
        const call = ++round === 1 ? { id: 'level', name: 'level_get_info', input: {} }
          : { id: 'lights', name: 'inspect_lights', input: { first: 'A', second: 'B' } };
        yield { type: 'done', response: { stopReason: 'tool_use', toolCalls: [call] } };
        return;
      }
      assert.deepEqual(JSON.parse(messages.at(-1).content[0].content), { lights: ['A', 'B'] });
      yield { type: 'text_delta', text: 'Inspected both.' };
      yield { type: 'done', response: { stopReason: 'end_turn' } };
    } };
    await runTurn(chat, 'Inspect', client, new AbortController().signal, () => {}, async () => '{}',
      { automatic, inspect: async (a, b) => [a, b] });
    assert.equal(chat.messages.at(-1).text, 'Inspected both.');
    assert.deepEqual(chat.messages.at(-1).steps.map((s) => s.status), ['complete', 'complete']);
  }
});

test('chat preferences reach the model and limit consecutive tool calls', async () => {
  const chat = newChat();
  let reads = 0;
  const client = {
    async *stream({ tools, system, maxTokens }) {
      assert.match(system, /Use short technical answers/);
      assert.equal(maxTokens, 1024);
      if (tools?.length) {
        yield { type: 'done', response: { stopReason: 'tool_use', toolCalls: [{ id: 'lookup' + reads, name: 'level_get_info', input: {} }] } };
      } else {
        yield { type: 'done', response: { stopReason: 'end_turn', content: 'Read budget reached.' } };
      }
    },
  };
  await runTurn(chat, 'Inspect level', client, new AbortController().signal, () => {}, async () => { reads++; return '{}'; },
    null, { customInstructions: 'Use short technical answers', maxTokens: 1024, maxToolCalls: 4 });
  assert.equal(reads, 4);
  assert.equal(chat.messages.at(-1).text, 'Read budget reached.');
});
