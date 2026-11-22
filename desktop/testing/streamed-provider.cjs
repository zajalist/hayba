// Installed by Playwright in the test app's main process. Unreal and MCP stay live.
module.exports = function installProviderFixture() {
  global.fetch = async (url, options) => {
    if (!String(url).startsWith('https://api.openai.com/')) throw Error('Unexpected provider destination');
    const body = JSON.parse(options.body);
    if (!body.stream) throw Error('Expected a streaming tool turn');
    const last = body.messages.at(-1);
    const prompt = body.messages.findLast((m) => m.role === 'user').content.toLowerCase();
    const chunk = (delta, reason) => 'data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: reason }] }) + '\n\n';
    const stream = (delta, reason) => new Response(chunk(delta, null) + chunk({}, reason) + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    const call = (name, args) => stream({ tool_calls: [{ index: 0, id: 'fixture-' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
    if (last.role !== 'tool') {
      if (prompt.includes('undo')) return call('undo_light_intensity', {});
      return call('level_get_info', {});
    }
    const data = JSON.parse(last.content);
    if (last.tool_call_id === 'fixture-level_get_info') {
      if (!data.map_name || !Number.isInteger(data.actor_count)) throw Error('Missing live level');
      global.__qaLevel = data;
      if (!prompt.includes('entrance')) return stream({ content: 'Rendered fixture reply' }, 'stop');
      return call('inspect_lights', { first: 'Entrance Key', second: 'Entrance Fill', target: 'Entrance Key', intensity: 1800 });
    }
    if (data.status === 'undone' && data.lights[0].intensity === 1200 && data.lights[1].intensity === 400)
      return stream({ content: 'Restored and verified both lights.' }, 'stop');
    if (data.status === 'applied' && data.lights[0].intensity === 1800 && data.lights[1].intensity === 400)
      return stream({ content: 'Applied and verified both lights.' }, 'stop');
    if (data.pendingApproval?.proposed === 1800 && data.lights?.length === 2)
      return stream({ content: 'The two lights have been inspected. Review the proposed change below.' }, 'stop');
    throw Error('The live editor did not return the expected result.');
  };
};
