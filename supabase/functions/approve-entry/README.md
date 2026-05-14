# approve-entry

Supabase Edge Function for admin-only waitlist approvals.

## What it does

1. Validates the calling user has `profiles.is_admin = true`
2. Updates `waitlist_entries.status` to `approved`
3. Sends a magic-link invite to the entry's email via `auth.admin.inviteUserByEmail`
4. Rolls back the status update if the invite send fails

## Required env

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Both are provided by Supabase OSS / hosted automatically.

## Deploy

After Phase 6 brings Supabase up on srv-dev-01:

```bash
supabase functions deploy approve-entry --project-ref local
```

Verify in Studio that `SUPABASE_SERVICE_ROLE_KEY` is set in the function env.

## Invoking

From the `/admin` page client:

```js
await supabase.functions.invoke('approve-entry', { body: { id: 42 } });
```

The user's bearer token is auto-forwarded; the function reads it from the
`Authorization` header.
