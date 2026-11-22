const { newChat } = require('./session.cjs');

function hasContent(chat) {
  return chat.messages.length > 0 || Boolean(chat.draft?.trim());
}

function chatTitle(chat) {
  const first =
    chat.messages.find((message) => message.role === 'user' && message.text?.trim()) ||
    chat.messages.find((message) => message.text?.trim());
  const text = first?.text || chat.draft || '';
  return text.trim().replace(/\s+/g, ' ').slice(0, 70) || (chat.messages.length ? 'Conversation' : 'New conversation');
}

function byNewest(first, second) {
  return (second.updatedAt || '').localeCompare(first.updatedAt || '');
}

function historyRows(chats, archived = false) {
  return chats
    .filter((chat) => hasContent(chat) && Boolean(chat.archivedAt) === archived)
    .sort(archived ? (a, b) => b.archivedAt.localeCompare(a.archivedAt) : byNewest)
    .map((chat) => ({
      id: chat.id,
      title: chatTitle(chat),
      updatedAt: chat.updatedAt,
      isDraft: !chat.messages.length,
    }));
}

// Only the selected composer may be empty in memory. A saved null selection reopens a fresh composer.
function selectChat(chats, selected) {
  const current = selected || newChat();
  const kept = chats.filter((chat) => chat === current || hasContent(chat));
  if (!kept.includes(current)) kept.unshift(current);
  return { chats: kept, current };
}

function mostRecentActive(chats) {
  return chats.filter((chat) => !chat.archivedAt && hasContent(chat)).sort(byNewest)[0];
}

function openHistory(stored) {
  if (stored == null) return selectChat([]);
  const { chats, current } = stored;
  // Reject unrecognized data before the main process writes the cleaned history to disk.
  if (
    !Array.isArray(chats) ||
    chats.some(
      (chat) =>
        typeof chat?.id !== 'string' ||
        !Array.isArray(chat.messages) ||
        (chat.draft != null && typeof chat.draft !== 'string'),
    )
  ) {
    throw Error('Invalid conversation history.');
  }
  const selected = chats.find((chat) => !chat.archivedAt && chat.id === current);
  return selectChat(chats, selected || (current !== null && mostRecentActive(chats)));
}

function serializeHistory(chats, current) {
  return { chats: chats.filter(hasContent), current: hasContent(current) ? current.id : null };
}

function changeHistory(chats, current, action, id) {
  if (action === 'new') {
    return hasContent(current) ? selectChat(chats) : { chats, current };
  }
  const target = chats.find((chat) => chat.id === id);
  if (!target || !hasContent(target)) return { chats, current };
  if (action === 'session') {
    return target.archivedAt || current === target ? { chats, current } : selectChat(chats, target);
  }
  if (action === 'archive' && !target.archivedAt) {
    const next = chats.map((chat) => (chat === target ? { ...chat, archivedAt: new Date().toISOString() } : chat));
    return selectChat(next, current === target ? mostRecentActive(next) : current);
  }
  if (action === 'restore' && target.archivedAt) {
    const { archivedAt, ...restored } = target;
    return { chats: chats.map((chat) => (chat === target ? restored : chat)), current };
  }
  return { chats, current };
}

module.exports = { openHistory, serializeHistory, changeHistory, chatTitle, historyRows };
