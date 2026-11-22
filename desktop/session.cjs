const { randomUUID } = require('node:crypto');

function newChat() {
  return { id: randomUUID(), updatedAt: new Date().toISOString(), draft: '', messages: [] };
}

async function runTurn(chat, prompt, client, signal, update, inspectLevel) {
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
    const system = inspectLevel
      ? 'You are Hayba Desktop. Use level_get_info for questions about the live Unreal level. You have read-only access to its metadata.'
      : 'You are Hayba Desktop. This standalone chat has no access to the Unreal scene or tools.';
    if (inspectLevel) {
      const tool = {
        name: 'level_get_info',
        description: 'Read the current map, package, actor count and play state.',
        input_schema: { type: 'object', properties: {} },
      };
      const decision = await client.complete({ messages, signal, system, tools: [tool] });
      if (!decision.toolCalls.length) {
        if (!decision.content || !['end_turn', 'stop_sequence'].includes(decision.stopReason))
          throw Error('Incomplete response');
        signal.throwIfAborted();
        reply.text = decision.content;
        delete user.incomplete;
        delete reply.incomplete;
        update();
        return;
      }
      const [call] = decision.toolCalls;
      if (decision.toolCalls.length !== 1 || call.name !== tool.name || Object.keys(call.input).length)
        throw Error('Unsupported editor action');
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', ...call }] });
      let result;
      reply.levelRead = { status: 'reading' };
      update();
      try {
        const content = await inspectLevel(signal);
        signal.throwIfAborted();
        reply.levelRead = { status: 'complete', metadata: JSON.parse(content) };
        result = { content };
      } catch {
        reply.levelRead = { status: signal.aborted ? 'stopped' : 'unavailable' };
        signal.throwIfAborted();
        result = {
          content:
            'The selected Unreal project did not return level information. Check that it is open with Hayba enabled.',
          is_error: true,
        };
      }
      update();
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, ...result }] });
    }
    let finished = false;
    for await (const event of client.stream({
      messages,
      signal,
      system,
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
