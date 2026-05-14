import { describe, expect, it } from 'vitest';

describe('website smoke', () => {
  it.skip('full flow — manual checklist for first deploy', () => {
    // This is a CHECKLIST, not an automated test, because the flow
    // requires a real Postgres and real email. Run by hand on first deploy.
    //
    // 1. Open https://hayba.app/ — verify slate theme, "Join the waitlist" CTA.
    // 2. Submit /waitlist with email + tools + notes — see success state.
    // 3. As admin, /admin shows 1 pending. Click Approve.
    // 4. Receive magic-link email at the submitted address. Click.
    // 5. Land on /app. Workbench renders. Top-bar lang picker is empty.
    // 6. Click + New — type "test-lang". Workbench loads with empty inventory.
    // 7. Add 12 phonemes. Wait 3s. Reload page — phonemes persist.
    // 8. Open another browser, sign in with same email. See "test-lang" in picker.
    // 9. Click Share. Toggle public. Copy URL.
    // 10. Open URL in incognito. Read-only banner shows. Edits disabled.
    // 11. Click "Sign in to fork" → land at /login.
    expect(true).toBe(true);
  });
});
