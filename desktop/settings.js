const field = (id) => document.getElementById(id);
async function store(value) {
  try {
    if (await window.providerSettings.save(value)) return;
  } catch {}
  field('status').textContent = 'Could not save the connection. Check the model ID and key, then try again.';
}
window.providerSettings.info().then((config) => {
  if (config.provider) {
    field('provider').value = config.provider;
    field('model').value = config.model;
    field('remove').hidden = false;
  }
});
document.querySelector('form').onsubmit = (event) => {
  event.preventDefault();
  store({ provider: field('provider').value, model: field('model').value.trim(), key: field('key').value });
};
field('remove').onclick = () => store(null);
