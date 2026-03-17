#!/bin/sh
# Backup dos volumes de sessão (WhatsApp, Telegram, Mercado Livre).
# Roda como container separado via cron.
set -e

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_SCHEDULE="${BACKUP_SCHEDULE:-0 4 * * *}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"

mkdir -p "$BACKUP_DIR"

# Escreve o script de backup com variáveis expandidas (cron não herda env)
cat > /run-sessions-backup.sh << SCRIPT
#!/bin/sh
TIMESTAMP=\$(date +%Y-%m-%d_%H-%M-%S)
FILE="${BACKUP_DIR}/sessions_\${TIMESTAMP}.tar.gz"
echo "[sessions-backup] \$(date) Iniciando: \$FILE"
tar -czf "\$FILE" -C /data wa-sessions tg-sessions meli-sessions 2>/dev/null || true
echo "[sessions-backup] \$(date) Done: \$(du -sh "\$FILE" | cut -f1)"
find "${BACKUP_DIR}" -name "sessions_*.tar.gz" -mtime +${BACKUP_KEEP_DAYS} -delete
echo "[sessions-backup] \$(date) Backups mantidos (ultimos ${BACKUP_KEEP_DAYS} dias):"
ls -lh "${BACKUP_DIR}"/sessions_*.tar.gz 2>/dev/null || echo "  (nenhum ainda)"
SCRIPT

chmod +x /run-sessions-backup.sh

echo "${BACKUP_SCHEDULE} /run-sessions-backup.sh >> /var/log/sessions-backup.log 2>&1" > /etc/crontabs/root

echo "[sessions-backup] Agendador iniciado."
echo "[sessions-backup] Schedule : ${BACKUP_SCHEDULE}"
echo "[sessions-backup] Backups  : ${BACKUP_DIR}"
echo "[sessions-backup] Reter    : ${BACKUP_KEEP_DAYS} dias"

exec crond -f -d 8
