#!/bin/sh
# Backup container entrypoint.
# Embeds env vars into the backup script at startup (so cron inherits them),
# then launches crond in the foreground.
set -e

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_SCHEDULE="${BACKUP_SCHEDULE:-0 3 * * *}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"

mkdir -p "$BACKUP_DIR"

# Write the backup script with env vars baked in (avoids cron env-inheritance issues)
cat > /run-backup.sh << SCRIPT
#!/bin/sh
TIMESTAMP=\$(date +%Y-%m-%d_%H-%M-%S)
TMP_FILE="${BACKUP_DIR}/autolinks_\${TIMESTAMP}.sql"
FILE="\${TMP_FILE}.gz"
echo "[pg-backup] \$(date) Starting: \$FILE"
if ! PGPASSWORD="${POSTGRES_PASSWORD}" pg_dump \\
  -h "${POSTGRES_HOST:-postgres}" \\
  -p "${POSTGRES_PORT:-5432}" \\
  -U "${POSTGRES_USER:-autolinks}" \\
  -d "${POSTGRES_DB:-autolinks}" \\
  --no-owner --no-acl > "\$TMP_FILE"; then
  echo "[pg-backup] \$(date) FAILED: pg_dump returned error, removing partial files"
  rm -f "\$TMP_FILE" "\$FILE"
  exit 1
fi
if ! gzip "\$TMP_FILE"; then
  echo "[pg-backup] \$(date) FAILED: gzip returned error, removing partial files"
  rm -f "\$TMP_FILE" "\$FILE"
  exit 1
fi
echo "[pg-backup] \$(date) Done: \$(du -sh "\$FILE" | cut -f1)"
find "${BACKUP_DIR}" -name "autolinks_*.sql.gz" -mtime +${BACKUP_KEEP_DAYS} -delete
echo "[pg-backup] \$(date) Backups retained (last ${BACKUP_KEEP_DAYS} days):"
ls -lh "${BACKUP_DIR}"/autolinks_*.sql.gz 2>/dev/null || echo "  (none yet)"
SCRIPT

chmod +x /run-backup.sh

# Install crontab
echo "${BACKUP_SCHEDULE} /run-backup.sh >> /var/log/pg-backup.log 2>&1" > /etc/crontabs/root

echo "[pg-backup] Scheduler started."
echo "[pg-backup] Schedule : ${BACKUP_SCHEDULE}"
echo "[pg-backup] Backups  : ${BACKUP_DIR}"
echo "[pg-backup] Retain   : ${BACKUP_KEEP_DAYS} days"

exec crond -f -d 8
