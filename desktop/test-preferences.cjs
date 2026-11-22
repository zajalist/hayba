const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const { DEFAULT_PREFERENCES, normalizePreferences, updatePreferences } = require('./preferences.cjs');

async function openSettings(app, page) {
  const next = app.waitForEvent('window');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = await next;
  await settings.getByLabel('Provider', { exact: true }).waitFor();
  return settings;
}

async function saveConnection(settings) {
  const closed = settings.waitForEvent('close');
  await settings.getByRole('button', { name: 'Save connection' }).click().catch((error) => {
    if (!settings.isClosed()) throw error;
  });
  await closed;
}

async function main() {
  assert.deepEqual(normalizePreferences(null), DEFAULT_PREFERENCES);
  assert.deepEqual(normalizePreferences({ followOutput: false, density: 'unknown', maxTokens: -1 }),
    { ...DEFAULT_PREFERENCES, followOutput: false });
  assert.throws(() => updatePreferences(DEFAULT_PREFERENCES, { followOutput: false, maxToolCalls: 0 }));
  assert.throws(() => updatePreferences(DEFAULT_PREFERENCES, { apiKey: 'unknown-field' }));
  assert.throws(() => updatePreferences(DEFAULT_PREFERENCES, { customInstructions: 'x'.repeat(2001) }));

  const executablePath = path.resolve(process.argv[2] || path.join(__dirname, 'bin/app/Hayba.exe'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hayba-preferences-'));
  const launch = () => _electron.launch({ executablePath, args: ['--user-data-dir=' + profile] });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    let settings = await openSettings(app, page);
    const provider = settings.getByLabel('Provider', { exact: true });
    const instructions = 'List Unreal asset paths on their own lines.';
    await provider.selectOption('custom');
    assert.equal(await settings.getByLabel('Custom endpoint').evaluate((el) => el.required), true);
    await provider.selectOption('ollama');
    assert.equal(await settings.getByLabel('API key').evaluate((el) => el.required), false);
    await provider.selectOption('openai');
    await settings.getByLabel('Model ID').fill('qa-model');
    await settings.getByLabel('API key').fill('test-only-placeholder');
    await settings.getByLabel('Custom endpoint').fill('http://localhost:1234/v1');
    assert.equal(await settings.getByLabel('API key').inputValue(), '');
    await settings.getByLabel('Custom endpoint').fill('');
    await settings.getByLabel('API key').fill('test-only-placeholder');

    await settings.getByRole('button', { name: 'Chat & display' }).click();
    assert.equal(await settings.getByLabel('Send message with').inputValue(), 'enter');
    await settings.getByLabel('Send message with').selectOption('modifier-enter');
    await settings.getByLabel('Text size').selectOption('large');
    await settings.getByLabel('Message spacing').selectOption('compact');
    await settings.getByRole('switch', { name: 'Expand tool details' }).check();
    await settings.getByRole('switch', { name: 'Follow new output' }).uncheck();
    await settings.getByRole('button', { name: 'Agent behavior' }).click();
    await settings.getByLabel('Custom instructions').fill(instructions);
    await settings.getByLabel('Response token limit').selectOption('1024');
    await settings.getByLabel('Tool calls per turn').selectOption('4');
    await settings.getByRole('button', { name: 'Save preferences' }).click();
    await settings.getByText('Preferences saved.').waitFor();
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile, 'preferences.json'))), {
      sendShortcut: 'modifier-enter', transcriptSize: 'large', density: 'compact',
      expandToolDetails: true, followOutput: false, customInstructions: instructions, maxTokens: 1024, maxToolCalls: 4,
    });
    await settings.getByRole('button', { name: 'Connection', exact: true }).click();
    await saveConnection(settings);
    await page.getByText('qa-model', { exact: true }).waitFor();
    assert.ok(!fs.readFileSync(path.join(profile, 'provider.json'), 'utf8').includes('test-only-placeholder'));

    await app.close();
    // Reopen an existing conversation long enough to exercise the display and follow settings.
    const chat = {
      id: 'saved-settings-fixture', updatedAt: new Date().toISOString(), draft: '',
      messages: Array.from({ length: 24 }, (_, id) => ({
        id, role: id % 2 ? 'assistant' : 'user', text: 'Earlier message ' + id,
      })),
    };
    chat.messages[1].levelRead = { status: 'complete', metadata: { map_name: 'Fixture', actor_count: 2 } };
    fs.writeFileSync(path.join(profile, 'conversations.json'), JSON.stringify({ chats: [chat], current: chat.id }));
    app = await launch();
    page = await app.firstWindow();
    await page.locator('.shell[data-density="compact"][data-transcript="large"]').waitFor();
    await page.locator('details.read-result[open]').waitFor();
    assert.equal(await page.locator('.transcript').evaluate((el) => getComputedStyle(el).fontSize), '17px');
    assert.equal(await page.locator('.message').first().evaluate((el) => getComputedStyle(el).marginBottom), '12px');
    assert.ok(await page.locator('.scroll').evaluate((el) => el.scrollHeight > el.clientHeight && el.scrollTop === 0));
    settings = await openSettings(app, page);
    await settings.getByText('Key saved', { exact: true }).waitFor();
    assert.equal(await settings.getByLabel('API key').inputValue(), '');
    await settings.getByLabel('Custom endpoint').fill('http://localhost:1234/v1');
    assert.equal(await settings.getByLabel('API key').evaluate((el) => el.required && !el.checkValidity()), true);
    await settings.getByLabel('Provider', { exact: true }).selectOption('ollama');
    await settings.getByLabel('Model ID').fill('qa-local-model');
    await saveConnection(settings);
    await page.getByText('qa-local-model', { exact: true }).waitFor();
    assert.ok(!JSON.parse(fs.readFileSync(path.join(profile, 'provider.json'))).secret);

    // Intercept every provider request before sending. No service or credentials are needed.
    await app.evaluate(() => {
      global.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        global.__preferencesRequest = {
          url: String(url), maxTokens: body.max_tokens, system: body.messages.find((m) => m.role === 'system')?.content,
        };
        const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({
          id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }],
        }) + '\n\n';
        return new Response(chunk({ content: 'Preferences fixture reply' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      };
    });
    await page.locator('#prompt').fill('Test');
    await page.locator('#prompt').press('End');
    await page.locator('#prompt').press('Enter');
    assert.equal(await page.locator('#prompt').inputValue(), 'Test\n');
    await page.locator('#prompt').press('Control+Enter');
    await page.getByText('Preferences fixture reply', { exact: true }).waitFor();
    const request = await app.evaluate(() => global.__preferencesRequest);
    assert.equal(new URL(request.url).origin, 'http://localhost:11434');
    assert.equal(request.maxTokens, 1024);
    assert.ok(request.system.includes(instructions));

    settings = await openSettings(app, page);
    await settings.getByRole('button', { name: 'Chat & display' }).click();
    await settings.getByRole('button', { name: 'Use defaults' }).click();
    await settings.getByRole('button', { name: 'Save preferences' }).click();
    await settings.getByText('Preferences saved.').waitFor();
    await page.locator('.shell[data-density="comfortable"][data-transcript="standard"]').waitFor();
    assert.equal(await page.locator('details.read-result').evaluate((el) => el.open), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'preferences.json'))).maxToolCalls, 4);
    console.log('PASS: preference persistence, keyboard shortcut, custom guidance, response cap, endpoint-bound keys, keyless local provider and scoped defaults');
  } finally {
    await app.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
