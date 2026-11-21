const chat = window.haybaChat;
const promptBox = document.getElementById('prompt');
document.querySelector('#empty p').textContent = 'Plan your Unreal project or discuss a technical question.';
document.getElementById('mode-hint').textContent = 'Standalone conversation';
const settingsButton = document.getElementById('more-button');
settingsButton.replaceWith(settingsButton.cloneNode(true));
const settings = document.getElementById('more-button');
settings.title = 'Provider settings';
settings.setAttribute('aria-label', settings.title);
settings.onclick = () => chat.dispatch('settings');
window.haybaDesktop.onSnapshot((state) => chat.receive(state));
window.haybaDesktop.onDraft((value) => {
  promptBox.value = value;
  promptBox.dispatchEvent(new Event('input'));
});
chat.init('desktop');
