const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hayba-desktop-smoke-'));
  const app = await _electron.launch({
    executablePath: process.argv[2] || path.join(__dirname, 'bin/app/Hayba.exe'),
    args: ['--user-data-dir=' + profile],
  });
  try {
    const page = await app.firstWindow();
    await page.getByText('Hayba Desktop', { exact: true }).waitFor();
    const next = app.waitForEvent('window');
    await page.getByRole('button', { name: 'Open settings' }).click();
    const settings = await next;
    await settings.locator('#provider').selectOption('openai');
    await settings.getByLabel('Model ID').fill('test-model');
    await settings.getByLabel('API key').fill('test-placeholder-only');
    await settings.getByText('Save connection').click();
    await page.getByText('test-model', { exact: true }).waitFor();
    assert.ok(!fs.readFileSync(path.join(profile, 'provider.json'), 'utf8').includes('test-placeholder-only'));
    const savedSecret = JSON.parse(fs.readFileSync(path.join(profile, 'provider.json'))).secret;
    const changedSettings = app.waitForEvent('window');
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items[0].click());
    const modelSettings = await changedSettings;
    await modelSettings.getByLabel('Model ID').fill('second-test-model');
    await modelSettings.getByText('Save connection').click();
    await page.getByText('second-test-model', { exact: true }).waitFor();
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'provider.json'))).secret, savedSecret);
    // Intercept the SDK in the test process so a fixture can never bill a provider.
    await app.evaluate(() => {
      global.fetch = async (url) => {
        if (!String(url).startsWith('https://api.openai.com/')) throw new Error('Unexpected destination');
        const chunk = (delta, finish_reason) =>
          'data: ' +
          JSON.stringify({
            id: 'fixture',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta, finish_reason }],
          }) +
          '\n\n';
        return new Response(
          chunk({ content: 'Rendered fixture reply' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      };
    });
    await page.locator('#prompt').fill('Test streaming');
    await page.locator('#send-button').click();
    await page.getByText('Rendered fixture reply', { exact: true }).waitFor();
    assert.equal(await page.locator('#messages article').count(), 2);
    console.log('PASS: packaged window, shared HTML, encrypted BYOK setup, SDK stream and transcript');
  } finally {
    await app.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
