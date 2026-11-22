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
    // Exercise the native picker's two outcomes without interacting with the user's projects.
    const fixtureProject = path.join(profile, 'Sample.uproject');
    fs.writeFileSync(fixtureProject, '{}');
    await app.evaluate(({ dialog }) => {
      global.__qaPicker = dialog.showOpenDialogSync;
      dialog.showOpenDialogSync = () => undefined;
    });
    const inspect = page.getByRole('button', { name: 'Inspect a level' });
    await inspect.click();
    assert.equal(await page.locator('#prompt').inputValue(), '');
    await app.evaluate(({ dialog }, project) => {
      dialog.showOpenDialogSync = () => [project];
    }, fixtureProject);
    await inspect.click();
    await page.getByRole('button', { name: 'Sample', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('#prompt').value.includes('actor count'));
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('button', { name: 'Share Unreal level' }).waitFor();
    await page.getByRole('navigation', { name: 'Conversations' }).getByRole('button').last().click();
    await page.getByRole('button', { name: 'Sample', exact: true }).click();
    await page.getByRole('button', { name: 'Share Unreal level' }).waitFor();
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialogSync = global.__qaPicker;
      delete global.__qaPicker;
    });
    await page.locator('#prompt').fill('');
    await page.getByRole('button', { name: 'Plan a feature' }).click();
    assert.match(await page.locator('#prompt').inputValue(), /implementation/);
    await page.keyboard.press('Control+k');
    const search = page.getByRole('dialog');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Search conversations');
    await search.getByRole('textbox').fill('missing conversation');
    await search.getByText('No matching conversations.').waitFor();
    await page.keyboard.press('Escape');
    await search.waitFor({ state: 'hidden' });
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
    if (process.argv.includes('--live-editor')) {
      const project = path.resolve(process.argv[process.argv.indexOf('--live-editor') + 1]);
      assert.ok(project.endsWith('.uproject') && fs.existsSync(project));
      await app.evaluate(({ Menu, dialog }, project) => {
        const item = Menu.getApplicationMenu().getMenuItemById('share-level');
        const pick = dialog.showOpenDialogSync;
        dialog.showOpenDialogSync = () => [project];
        try {
          item.click();
        } finally {
          dialog.showOpenDialogSync = pick;
        }
        const stream = global.fetch;
        global.fetch = async (url, options) => {
          if (!String(url).startsWith('https://api.openai.com/')) throw Error('Unexpected provider');
          const body = JSON.parse(options.body);
          if (body.tools?.some((tool) => tool.function.name === 'level_get_info')) {
            return Response.json({
              id: 'fixture',
              object: 'chat.completion',
              choices: [
                {
                  index: 0,
                  finish_reason: 'tool_calls',
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      { id: 'inspect', type: 'function', function: { name: 'level_get_info', arguments: '{}' } },
                    ],
                  },
                },
              ],
            });
          }
          const result = JSON.parse(body.messages.findLast((message) => message.role === 'tool').content);
          if (!result.map_name || !Number.isInteger(result.actor_count)) throw Error('Missing live level metadata');
          global.__qaLevel = result;
          return stream(url, options);
        };
      }, project);
      await page.locator('#prompt').fill('Inspect the current Unreal level');
      await page.locator('#send-button').click();
      await page.waitForFunction(
        () =>
          document.querySelectorAll('article[aria-label="Hayba message"] .body').length === 2 &&
          document
            .querySelectorAll('article[aria-label="Hayba message"] .body')[1]
            .innerText.includes('Rendered fixture reply'),
      );
      const result = await app.evaluate(() => global.__qaLevel);
      const receipt = page.locator('details.read-result');
      await receipt.locator('summary').click();
      assert.ok((await receipt.innerText()).includes(result.package_path));
      assert.equal(await receipt.getByText(String(result.actor_count), { exact: true }).count(), 1);
      console.log('Installed Desktop received the editor tool result:', JSON.stringify(result));
    }
    console.log('PASS: packaged React workspace, keyboard search, encrypted BYOK setup, SDK stream and transcript');
  } finally {
    await app.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
