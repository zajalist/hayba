#!/usr/bin/env bash
# infra/backup.sh — nightly pg_dump rotation, runs from srv-dev-02 cron.
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-srv-dev-01}"
DB_USER="${DB_USER:-supabase_admin}"
DB_NAME="${DB_NAME:-postgres}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/hayba-pg}"
RETAIN_DAYS="${RETAIN_DAYS:-30}"

mkdir -p "$BACKUP_DIR"
TS=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/hayba-$TS.sql.gz"

pg_dump -h "$REMOTE_HOST" -U "$DB_USER" -d "$DB_NAME" --no-owner --no-acl | gzip > "$OUT"

# Rotate.
find "$BACKUP_DIR" -name "hayba-*.sql.gz" -type f -mtime +"$RETAIN_DAYS" -delete
echo "[backup] wrote $OUT"
