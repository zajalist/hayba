import { auth } from '/lib/hayba-client.js';

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = e.target.email.value.trim();
  const next = new URL(window.location.href).searchParams.get('next') ?? '/app';
  const redirectTo = `${window.location.origin}${next}`;
  const { error } = await auth.signIn(email, { redirectTo });
  if (error) { alert('Failed: ' + error.message); return; }
  document.getElementById('login-form').style.display = 'none';
  document.getElementById('login-sent').hidden = false;
});
