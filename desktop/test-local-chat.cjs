const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

async function test() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hayba-endpoint-'));
  let request;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    request = { path: req.url, body: JSON.parse(body) };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    function chunk(delta, finish_reason = null) {
      res.write('data: ' + JSON.stringify({ id: 'fixture', model: 'local/test', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    }
    chunk({ role: 'assistant', content: 'Your local ' });
    chunk({ content: 'endpoint is connected.' });
    chunk({}, 'stop');
    res.end('data: [DONE]\n\n');
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  let app;
  try {
    app = await _electron.launch({ executablePath: process.argv[2], args: ['--user-data-dir=' + profile] });
    const page = await app.firstWindow();
    const opening = app.waitForEvent('window');
    await page.getByRole('button', { name: 'Open settings' }).click();
    const settings = await opening;
    await settings.locator('#provider').selectOption('custom');
    await settings.getByLabel(/Custom endpoint/i).fill('http://127.0.0.1:' + server.address().port + '/v1');
    await settings.getByLabel('Model ID').fill('local/test');
    await settings.getByRole('button', { name: 'Save connection' }).click().catch((err) => { if (!settings.isClosed()) throw err; });
    await page.getByText('local/test', { exact: true }).waitFor();
    await page.locator('#prompt').fill('Test my local connection');
    await page.locator('#prompt').press('Enter');
    await page.getByText('Your local endpoint is connected.', { exact: true }).waitFor();
    assert.equal(request.path, '/v1/chat/completions');
    assert.equal(request.body.model, 'local/test');
    assert.equal(request.body.messages.at(-1).content, 'Test my local connection');
    console.log('Installed custom provider used the real OpenAI client over a local HTTP connection; streamed reply rendered.');
  } finally {
    if (app) await app.close();
    await new Promise((done) => server.close(done));
  }
}
test().catch((error) => { console.error(error); process.exitCode = 1; });
