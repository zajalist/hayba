# Hayba self-hosted infra

## Prerequisites on srv-dev-01

- Docker Engine 24+ and docker compose v2
- 4GB RAM, 20GB disk minimum
- Outbound HTTPS to Cloudflare and the email provider

## Bring up the stack

```bash
cd infra
cp .env.example .env
# Edit .env to set POSTGRES_PASSWORD, JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY,
# DASHBOARD_USERNAME, DASHBOARD_PASSWORD, SMTP_* etc.
docker compose -f docker-compose.supabase.yml up -d
```

## Apply migrations

```bash
psql "$POSTGRES_URL" -f ../packages/linguistics/migrations/0001_lexicon.sql
psql "$POSTGRES_URL" -f ../packages/linguistics/migrations/0002_lexicon_pos.sql
psql "$POSTGRES_URL" -f ../packages/linguistics/migrations/0003_wordlinks.sql
psql "$POSTGRES_URL" -f ../packages/linguistics/migrations/0004_auth_profiles.sql
psql "$POSTGRES_URL" -f ../packages/linguistics/migrations/0005_waitlist.sql
psql "$POSTGRES_URL" -f ../packages/linguistics/migrations/0006_languages.sql
```

## Bootstrap an admin

```sql
update profiles set is_admin = true where user_id = (
  select id from auth.users where email = 'YOUR@EMAIL'
);
```

## Cloudflare Tunnel

1. `cloudflared tunnel login`
2. `cloudflared tunnel create hayba-api`
3. Copy the tunnel ID into `cloudflared.yml` (replace `REPLACE_WITH_TUNNEL_ID` in both places)
4. `cloudflared tunnel route dns hayba-api api.hayba.app`
5. `sudo systemctl enable --now cloudflared` (uses cloudflared.yml as default config)

## Vercel env vars (Project → Settings → Environment Variables)

- `VERCEL_PUBLIC_HAYBA_API_URL` = `https://api.hayba.app`
- `VERCEL_PUBLIC_HAYBA_ANON_KEY` = (anon JWT from Supabase Studio)

The `vercel-build` script in the root `package.json` substitutes these into
`website/config.js` at deploy time. Every HTML entrypoint loads `/config.js`
before any auth/Supabase code, populating `window.HAYBA_CONFIG`.

## srv-dev-02 backups

Cron entry:

```bash
crontab -e
# Add:
0 4 * * * /path/to/infra/backup.sh >> /var/log/hayba-backup.log 2>&1
```
