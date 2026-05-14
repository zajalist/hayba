import { createHaybaSupabaseClient } from '/dist/supabase-client.js';

const CONFIG = window.HAYBA_CONFIG ?? { url: 'http://localhost:54321', anonKey: '...' };
const supabase = createHaybaSupabaseClient(CONFIG);

document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const email = e.target.email.value.trim();
  const next = new URL(window.location.href).searchParams.get('next') ?? '/app';
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${window.location.origin}${next}` },
  });
  if (error) { alert('Failed: ' + error.message); return; }
  document.getElementById('login-form').style.display = 'none';
  document.getElementById('login-sent').hidden = false;
});
