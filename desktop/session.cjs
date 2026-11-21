const { randomUUID } = require('node:crypto');

function newChat() {
  return { id: randomUUID(), updatedAt: new Date().toISOString(), draft: '', messages: [] };
}

async function runTurn(chat, prompt, client, signal, update) {
  const add = (role, text) => {
    const row = { id: chat.messages.length, role, text };
    chat.messages.push(row);
    return row;
  };
  const user = add('user', prompt);
  const messages = chat.messages
    .filter((m) => !m.notice && !m.incomplete)
    .map(({ role, text }) => ({ role, content: text }));
  const reply = add('assistant', '');
  reply.incomplete = true;
  user.incomplete = true;
  chat.draft = '';
  chat.updatedAt = new Date().toISOString();
  update();
  try {
    let finished = false;
    for await (const event of client.stream({
      messages,
      signal,
      system: 'You are Hayba Desktop. This standalone chat has no access to the Unreal scene or tools.',
    })) {
      if (event.type === 'text_delta') {
        reply.text += event.text;
        update();
      } else if (event.type === 'done') {
        if (event.response.stopReason !== 'end_turn' && event.response.stopReason !== 'stop_sequence')
          throw new Error('Incomplete response');
        reply.text ||= event.response.content || '';
        finished = Boolean(reply.text);
      }
    }
    if (!finished || signal.aborted) throw new Error('Interrupted stream');
    delete user.incomplete;
    delete reply.incomplete;
  } catch (error) {
    const reasons = {
      auth: 'Check your provider key and model access.',
      rate_limit: 'Your provider rate limit was reached.',
      network: 'Check your network connection.',
    };
    const reason = signal.aborted
      ? 'Response stopped.'
      : reasons[error.kind] || 'The provider could not finish the response. Check the model and your provider account.';
    reply.text = [reply.text, reason].filter(Boolean).join('\n\n');
    reply.notice = true;
    if (!chat.draft) chat.draft = prompt;
  }
  update();
}
module.exports = { newChat, runTurn };
