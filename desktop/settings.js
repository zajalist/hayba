const field = (id) => document.getElementById(id);
async function store(value) {
  try {
    if (await window.providerSettings.save(value)) return;
  } catch {}
  field('status').textContent = 'Could not save the connection. Check the model ID and key, then try again.';
}
window.providerSettings.info().then((config) => {
  const provider = field('provider');
  const key = field('key');
  function selectProvider() {
    const saved = config.provider === provider.value;
    key.value = '';
    key.required = !saved;
    key.placeholder = saved ? 'Leave blank to keep your saved key' : 'Paste your provider API key';
    field('model').value = saved ? config.model : '';
    field('model').placeholder = provider.value === 'openai' ? 'Model ID from your OpenAI account' : 'Model ID from your Anthropic account';
    field('remove').hidden = !saved;
  }
  if (config.provider) {
    provider.value = config.provider;
  }
  selectProvider();
  provider.onchange = selectProvider;
});
document.querySelector('form').onsubmit = (event) => {
  event.preventDefault();
  store({ provider: field('provider').value, model: field('model').value.trim(), key: field('key').value });
};
field('remove').onclick = () => store(null);
