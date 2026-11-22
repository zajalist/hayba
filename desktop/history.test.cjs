const assert = require('node:assert/strict');
const test = require('node:test');
const { openHistory, serializeHistory, changeHistory, chatTitle, historyRows } = require('./history.cjs');

const day = (n) => `2026-01-0${n}T12:00:00.000Z`;
const chat = (id, values = {}) => ({ id, updatedAt: day(1), messages: [], draft: '', ...values });
const change = (state, action, id) => changeHistory(state.chats, state.current, action, id);
const saved = (state) => JSON.parse(JSON.stringify(serializeHistory(state.chats, state.current)));

test('migrates old placeholders while retaining drafts, transcript metadata and the current chat', () => {
  const draft = chat('draft', { draft: '  First line\nsecond line  ', updatedAt: day(3) });
  const rich = chat('rich', { messages: [{ role: 'assistant', text: '', lighting: { id: 'project receipt' } }] });
  const old = [chat('blank-1'), draft, chat('blank-2', { draft: ' \t ' }), rich, chat('blank-3')];
  const state = openHistory({ current: 'draft', chats: old });
  assert.equal(state.current, draft);
  assert.deepEqual(state.chats, [draft, rich]);
  assert.deepEqual(saved(state), { chats: [draft, rich], current: 'draft' });
  assert.deepEqual(
    historyRows(old).map(({ title, isDraft }) => [title, isDraft]),
    [
      ['First line second line', true],
      ['Conversation', false],
    ],
  );
  assert.deepEqual(openHistory(saved(state)), state);
});

test('reuses an empty current composer, never stores a blank row and reopens a blank selection after restart', () => {
  const conversation = chat('existing', { messages: [{ role: 'user', text: 'Earlier question' }] });
  const state = openHistory({
    current: 'selected-blank',
    chats: [chat('selected-blank'), chat('extra'), conversation],
  });
  const repeated = change(change(state, 'new'), 'new');
  assert.equal(repeated.current, state.current);
  assert.deepEqual(repeated.chats, [state.current, conversation]);
  assert.deepEqual(saved(repeated), { chats: [conversation], current: null });
  const restarted = openHistory(saved(repeated));
  assert.deepEqual(restarted.current.messages, []);
  assert.deepEqual(
    historyRows(restarted.chats).map((s) => s.id),
    ['existing'],
  );
  const selected = change(restarted, 'session', 'existing');
  assert.deepEqual(selected.chats, [conversation]);
  assert.equal(selected.current.id, 'existing');
  assert.deepEqual(saved(openHistory(null)), { chats: [], current: null });
});

test('keeps unsent text on New, selection, archive, restore and restart', () => {
  const state = openHistory(null);
  const text = ' My draft  \n\nwith spacing ';
  state.current.draft = text;
  const id = state.current.id;
  let next = change(state, 'new');
  assert.notEqual(next.current.id, id);
  assert.equal(next.current.draft, '');
  assert.deepEqual(
    historyRows(next.chats).map((s) => s.id),
    [id],
  );
  next = change(next, 'session', id);
  assert.equal(next.current.draft, text);
  next = change(next, 'archive', id);
  assert.equal(next.current.draft, '');
  assert.deepEqual(historyRows(next.chats), []);
  assert.equal(historyRows(next.chats, true)[0].title, 'My draft with spacing');
  const repeated = change(next, 'archive', id);
  assert.equal(repeated.chats, next.chats);
  assert.equal(change(next, 'session', id).current, next.current);
  const restarted = openHistory(saved(next));
  next = change(restarted, 'restore', id);
  assert.equal(next.current, restarted.current);
  assert.deepEqual(historyRows(next.chats, true), []);
  assert.equal(change(next, 'restore', id).chats, next.chats);
  assert.equal(change(openHistory(saved(next)), 'session', id).current.draft, text);
});

test('archiving current selects the most recently edited active conversation and preserves all messages', () => {
  const first = chat('sent', {
    updatedAt: day(3),
    draft: 'next thought',
    messages: [
      { role: 'user', text: 'First question' },
      { role: 'assistant', text: 'First answer', steps: ['receipt'] },
    ],
  });
  const older = chat('older', { updatedAt: day(1), draft: 'Old draft' });
  const recent = chat('recent', { updatedAt: day(2), draft: 'Recent draft' });
  const state = openHistory({ chats: [older, first, recent], current: 'sent' });
  assert.deepEqual(
    historyRows(state.chats).map((s) => s.id),
    ['sent', 'recent', 'older'],
  );
  assert.equal(chatTitle(first), 'First question');
  const archived = change(state, 'archive', 'sent');
  assert.equal(archived.current, recent);
  const frozen = saved(archived);
  assert.deepEqual(frozen.chats.find((c) => c.id === 'sent').messages, first.messages);
  assert.equal(openHistory({ ...frozen, current: 'sent' }).current.id, 'recent');
  assert.equal(openHistory({ ...frozen, current: 'missing' }).current.id, 'recent');
  const restored = change(openHistory(frozen), 'restore', 'sent');
  assert.deepEqual(
    saved(restored).chats.find((c) => c.id === 'sent'),
    first,
  );
  assert.equal(change(restored, 'archive', 'missing').current, restored.current);
  assert.equal(change(restored, 'archive', 'older').current, restored.current);
});

test('does not rewrite malformed legacy history as an empty profile', () => {
  assert.throws(() => openHistory({}), /Invalid conversation history/);
  assert.throws(
    () => openHistory({ chats: [{ id: 'old', messages: 'unrecognized format' }] }),
    /Invalid conversation history/,
  );
});
