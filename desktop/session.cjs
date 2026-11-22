const { randomUUID } = require('node:crypto');

function newChat() {
  return { id: randomUUID(), updatedAt: new Date().toISOString(), draft: '', messages: [] };
}

const nameField = { type: 'string', minLength: 1 };
const intensityField = { type: 'number', minimum: 0 };
function tool(name, description, properties = {}, required = []) {
  return { name, description, input_schema: { type: 'object', properties, required, additionalProperties: false } };
}
const levelTool = tool('level_get_info', 'Read the current map, package, actor count and play state.');
const lightTools = [
  tool('inspect_lights', 'Inspect two lights by actor name. Optionally request an intensity change to one.',
    { first: nameField, second: nameField, target: nameField, intensity: intensityField }, ['first', 'second']),
  tool('propose_light_intensity', 'Request an intensity change to one previously inspected light.',
    { target: nameField, intensity: intensityField }, ['target', 'intensity']),
];
const undoTool = tool('undo_light_intensity', 'Restore the last verified lighting edit in this project when the user asks to undo.');
const labels = { level_get_info: 'Read level', inspect_lights: 'Inspect lights', propose_light_intensity: 'Change light intensity', undo_light_intensity: 'Undo intensity change' };

async function execute(call, available, reply, inspectLevel, lighting, signal, update) {
  const step = { label: labels[call.name] || 'Unknown tool', status: 'running' };
  (reply.steps ||= []).push(step);
  if (call.name === levelTool.name) reply.levelRead = { status: 'reading' };
  update();
  try {
    signal.throwIfAborted();
    const definition = available.find((t) => t.name === call.name);
    const args = call.input;
    if (!definition || !args || typeof args !== 'object' || Array.isArray(args) ||
        Object.keys(args).some((k) => !Object.hasOwn(definition.input_schema.properties, k)) ||
        definition.input_schema.required.some((k) => !Object.hasOwn(args, k)))
      throw Error('Unsupported editor action or arguments.');
    let result;
    if (call.name === levelTool.name) {
      result = JSON.parse(await inspectLevel(signal));
      reply.levelRead = { status: 'complete', metadata: result };
    } else if (call.name === undoTool.name) {
      result = await lighting.undo();
    } else {
      const { first, second, target, intensity } = args;
      result = {};
      if (call.name === 'inspect_lights') result.lights = await lighting.inspect(first, second);
      signal.throwIfAborted();
      if (call.name === 'propose_light_intensity' || target !== undefined || intensity !== undefined)
        Object.assign(result, await lighting.propose(target, intensity));
    }
    signal.throwIfAborted();
    step.status = 'complete';
    return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result) };
  } catch (error) {
    step.status = signal.aborted ? 'stopped' : 'failed';
    if (call.name === levelTool.name) reply.levelRead = { status: signal.aborted ? 'stopped' : 'unavailable' };
    signal.throwIfAborted();
    step.detail = call.name === levelTool.name ? 'Open the selected project in Unreal with Hayba enabled.' : String(error.message).slice(0, 400);
    return { type: 'tool_result', tool_use_id: call.id, content: step.detail, is_error: true };
  } finally {
    update();
  }
}

async function runTurn(chat, prompt, client, signal, update, inspectLevel, lighting, preferences = {}) {
  const user = { id: chat.messages.length, role: 'user', text: prompt };
  chat.messages.push(user);
  const messages = chat.messages.filter((m) => !m.notice && !m.incomplete && !m.lighting)
    .map(({ role, text }) => ({ role, content: text }));
  const reply = { id: chat.messages.length, role: 'assistant', text: '', incomplete: true };
  chat.messages.push(reply);
  user.incomplete = true;
  chat.draft = '';
  chat.updatedAt = new Date().toISOString();
  update();
  try {
    const context = inspectLevel
      ? 'You are Hayba Desktop, an Unreal editor assistant. Use live tools for scene facts. Call tools until you can answer, and only change a light when asked. Report observed values and failed operations accurately. ' +
        (lighting?.automatic ? 'Automatic mode executes requested edits and supports verified undo.' : 'Review mode prepares a proposal. Tell the user it awaits approval.') +
        (lighting?.context ? '\nPrevious observation: ' + JSON.stringify(lighting.context) : '')
      : 'You are Hayba Desktop. No Unreal project is attached to this conversation.';
    const system = preferences.customInstructions ? context + '\nUser chat preferences:\n' + preferences.customInstructions : context;
    const available = inspectLevel ? [levelTool, ...(lighting ? lightTools : []), ...(lighting?.automatic ? [undoTool] : [])] : [];
    let remaining = preferences.maxToolCalls ?? 12;
    for (;;) {
      let response;
      let text = '';
      const tools = remaining ? available : [];
      for await (const event of client.stream({ messages, signal, system, maxTokens: preferences.maxTokens ?? 4096, ...(tools.length ? { tools } : {}) })) {
        signal.throwIfAborted();
        if (event.type === 'text_delta') {
          text += event.text;
          reply.text += event.text;
          update();
        } else if (event.type === 'done') response = event.response;
      }
      signal.throwIfAborted();
      if (!response) throw Error('Interrupted stream');
      const calls = response.toolCalls || [];
      if (calls.length === 0) {
        if (!['end_turn', 'stop_sequence'].includes(response.stopReason) || !(text || response.content))
          throw Error('Incomplete response');
        if (!text) reply.text += response.content;
        break;
      }
      if (response.stopReason !== 'tool_use' || calls.length > remaining || !tools.length ||
          new Set(calls.map((call) => call.id)).size !== calls.length)
        throw Error('Invalid tool round');
      remaining -= calls.length;
      const blocks = calls.map((call) => ({ type: 'tool_use', ...call }));
      if (text) {
        blocks.unshift({ type: 'text', text });
        reply.text += '\n\n';
      }
      messages.push({ role: 'assistant', content: blocks });
      const results = [];
      for (const call of calls) results.push(await execute(call, tools, reply, inspectLevel, lighting, signal, update));
      messages.push({ role: 'user', content: results });
    }
    delete user.incomplete;
    delete reply.incomplete;
  } catch (error) {
    const reasons = { auth: 'Check your provider key and model access.', rate_limit: 'Your provider rate limit was reached.', network: 'Check your network connection.' };
    const reason = signal.aborted ? 'Response stopped.' : reasons[error.kind] || 'The provider could not finish the response. Check the model and your provider account.';
    reply.text = [reply.text, reason].filter(Boolean).join('\n\n');
    reply.notice = true;
    if (!chat.draft) chat.draft = prompt;
  }
  update();
}
module.exports = { newChat, runTurn };
