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
