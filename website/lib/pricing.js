// Pricing: the Pro monthly/yearly toggle and the early-access waitlist form.
//
// Toggle: every [data-monthly][data-yearly] element in the section swaps its text.
// Waitlist: POSTs {email} to the form's action (/api/waitlist). States live on
// form[data-state]: idle, sending, sent, error, closed (backend not configured).

const RELEASES_URL = 'https://github.com/zajalist/hayba/releases';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function mountPricing(section) {
  if (!section) return;
  const swaps = section.querySelectorAll('[data-monthly][data-yearly]');
  for (const radio of section.querySelectorAll('input[name="billing"]')) {
    radio.addEventListener('change', () => {
      for (const el of swaps) el.textContent = el.dataset[radio.value];
    });
  }
  mountWaitlist(section.querySelector('form.waitlist'));
}

function mountWaitlist(form) {
  if (!form) return;
  const input = form.querySelector('input[name="email"]');
  const button = form.querySelector('button[type="submit"]');
  const status = form.querySelector('.waitlist-status');
  const idleLabel = button.textContent;

  const setState = (state, message, link) => {
    form.dataset.state = state;
    button.disabled = state === 'sending';
    button.textContent = state === 'sending' ? 'Joining…' : idleLabel;
    status.textContent = message;
    if (link) {
      const a = document.createElement('a');
      a.className = 'text-link';
      a.href = link.href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = link.text;
      status.append(' ', a);
    }
  };
  const invalid = (message) => {
    input.setAttribute('aria-invalid', 'true');
    setState('error', message);
    input.focus();
  };

  input.addEventListener('input', () => {
    if (form.dataset.state !== 'error') return;
    input.removeAttribute('aria-invalid');
    setState('idle', '');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (form.dataset.state === 'sending') return;
    const email = input.value.trim();
    if (!email) return invalid('Enter your email address to join the waitlist.');
    if (email.length > 254 || !EMAIL.test(email)) {
      return invalid('That email address looks incomplete. Check it and try again.');
    }

    input.removeAttribute('aria-invalid');
    setState('sending', 'Adding you to the waitlist…');
    try {
      const res = await fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        form.reset();
        setState('sent', "You're on the list. We'll email you when early access opens.");
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (res.status === 503 && body.error === 'waitlist_not_configured') {
        setState('closed', 'Waitlist opens soon.', { href: RELEASES_URL, text: 'Watch releases on GitHub' });
        return;
      }
      if (res.status === 400) return invalid('That email address looks incomplete. Check it and try again.');
      throw new Error(`waitlist ${res.status}`);
    } catch {
      setState('error', "Couldn't reach the waitlist. Check your connection and try again.");
    }
  });
}
