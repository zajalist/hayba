const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');

async function test() {
  const [exe, project, capture] = process.argv.slice(2);
  const automatic = process.argv.includes('--automatic');
  assert.equal(path.basename(project), 'LightingAcceptance.uproject');
  const saved = path.join(path.dirname(project), 'Saved');
  const values = () => fs.readFileSync(path.join(saved, 'lighting-values.txt'), 'utf8').replace(/^\uFEFF/, '').trim();
  async function observe(expected) {
    for (let i = 0; i < 40 && values() !== expected; i++) await delay(100);
    assert.equal(values(), expected);
  }
  await observe('1200,400');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hayba-lighting-'));
  const app = await _electron.launch({ executablePath: exe, args: ['--user-data-dir=' + profile] });
  const page = await app.firstWindow();
  page.setDefaultTimeout(45000);
  try {
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialogSync = () => [file]; }, project);
    await page.getByRole('button', { name: 'Lighting', exact: true }).click();
    const picker = page.getByRole('dialog');
    for (const [field, name] of [['First light', 'Entrance Key'], ['Second light', 'Entrance Fill']]) {
      const select = picker.getByLabel(field);
      const option = select.getByRole('option', { name: new RegExp(name) });
      await option.waitFor({ state: 'attached' });
      await select.selectOption(await option.getAttribute('value'));
    }
    await picker.getByRole('button', { name: 'Inspect lights' }).click();
    const card = page.getByRole('region', { name: 'Lighting review' }).last();
    if (!automatic) {
      await card.getByLabel('New intensity').fill('1800');
      await card.getByRole('button', { name: 'Review change' }).click();
      await card.getByRole('button', { name: 'Decline', exact: true }).click();
      await card.getByText('Declined · both values verified').waitFor();
      await observe('1200,400');
      console.log('Picker and decline: independent Unreal values 1200,400.');
    }
    const settingsWindow = app.waitForEvent('window');
    await page.getByRole('button', { name: 'Open settings' }).click();
    const settings = await settingsWindow;
    await settings.locator('#provider').selectOption('openai');
    await settings.getByLabel('Model ID').fill('fixture-model');
    await settings.getByLabel('API key').fill('fixture-only');
    await settings.getByText('Save connection').click().catch((error) => { if (!settings.isClosed()) throw error; });
    await page.getByText('fixture-model', {exact: true}).waitFor();
    await app.evaluate(require('./testing/streamed-provider.cjs'));
    if (automatic) await page.getByLabel('Project approval mode').selectOption('automatic');
    async function send(text) {
      await page.locator('#prompt').fill(text);
      await page.locator('#send-button').click();
    }
    await send('Inspect Entrance Key and Entrance Fill. Change Entrance Key intensity to 1800.');
    if (automatic) {
      await page.getByText('Applied and verified both lights.', { exact: true }).waitFor();
      await card.getByText('Applied · both values verified').waitFor();
      await observe('1800,400');
      assert.equal(await page.getByRole('button', { name: 'Approve change' }).count(), 0);
      await send('Undo my last lighting edit.');
      await page.getByText('Restored and verified both lights.', { exact: true }).waitFor();
      await card.getByText('Undone · both values verified').waitFor();
      await observe('1200,400');
      assert.equal(fs.existsSync(path.join(saved, 'lighting-test-click.txt')), false);
      console.log('Automatic chat: inspected level and lights, verified 1800,400; chat undo verified 1200,400. Zero approval clicks.');
      return;
    }
    await page.getByText('The two lights have been inspected. Review the proposed change below.').waitFor();
    const approve = card.getByRole('button', { name: 'Approve change' });
    await approve.waitFor();
    assert.equal(await approve.evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(212, 212, 212)');
    if (capture) {
      await approve.scrollIntoViewIfNeeded();
      await page.screenshot({ path: capture });
    }
    for (const [button, op, status, actual] of [
      [approve, 'apply', 'Applied · both values verified', '1800,400'],
      [card.getByRole('button', { name: 'Undo intensity change' }), 'undo', 'Undone · both values verified', '1200,400'],
    ]) {
      await button.click();
      await card.getByText(/Approve once in the Hayba panel/).waitFor();
      fs.writeFileSync(path.join(saved, 'lighting-test-click.txt'), op);
      await card.getByText(status).waitFor();
      await observe(actual);
      assert.deepEqual(await card.locator('tbody tr td:last-child').allTextContents(), actual.split(','));
      console.log(op + ': independent Unreal values ' + actual);
    }
  } catch (error) {
    console.error((await page.locator('body').innerText()).slice(-2400));
    throw error;
  } finally {
    await app.close();
  }
}
test().catch((error) => { console.error(error); process.exitCode = 1; });
