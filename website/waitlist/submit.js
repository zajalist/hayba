import { createHaybaSupabaseClient } from '/dist/supabase-client.js';

const CONFIG = window.HAYBA_CONFIG ?? {
  url: 'http://localhost:54321',
  anonKey: 'eyJ...local-anon-key...',
};
const supabase = createHaybaSupabaseClient(CONFIG);

document.getElementById('waitlist-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const tools = [...f.querySelectorAll('input[name=tools]:checked')].map(i => i.value);
  const payload = {
    email:         f.email.value.trim(),
    questionnaire: {
      making: f.making.value,
      tools,
      notes:  f.notes.value.trim() || null,
    },
  };
  const { error } = await supabase.from('waitlist_entries').insert(payload);
  if (error) {
    if (error.code === '23505') {
      alert('That email is already on the waitlist.');
    } else {
      alert('Something went wrong: ' + error.message);
    }
    return;
  }
  f.style.display = 'none';
  document.getElementById('waitlist-success').hidden = false;
});
