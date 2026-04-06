#!/bin/sh
# Backup dos volumes de sessão (WhatsApp, Telegram, Mercado Livre).
# Roda como container separado via cron.
set -e

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_SCHEDULE="${BACKUP_SCHEDULE:-0 4 * * *}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"

mkdir -p "$BACKUP_DIR"

# Se BACKUP_ENCRYPTION_KEY foi fornecida, salva em arquivo (cron não herda env).
# Isso evita expor o segredo em argumentos de processo e lida com chars especiais.
KEY_FILE="/run-backup.key"
if [ -n "${BACKUP_ENCRYPTION_KEY}" ]; then
  printf '%s' "${BACKUP_ENCRYPTION_KEY}" > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  echo "[sessions-backup] Encryption key carregada — backups serão cifrados (AES-256-CBC)."
else
  rm -f "$KEY_FILE"
  echo "[sessions-backup] AVISO: BACKUP_ENCRYPTION_KEY não definida — backups NAO cifrados."
fi

# Escreve o script de backup com variáveis expandidas (cron não herda env)
cat > /run-sessions-backup.sh << SCRIPT
#!/bin/sh
TIMESTAMP=\$(date +%Y-%m-%d_%H-%M-%S)
PLAIN="${BACKUP_DIR}/sessions_\${TIMESTAMP}.tar.gz"
echo "[sessions-backup] \$(date) Iniciando: \${PLAIN}"
tar -czf "\${PLAIN}" -C /data wa-sessions tg-sessions meli-sessions 2>/dev/null || true
if [ -f "${KEY_FILE}" ] && [ -s "${KEY_FILE}" ]; then
  ENC="\${PLAIN%.tar.gz}.tar.gz.enc"
  openssl enc -aes-256-cbc -pbkdf2 -iter 600000 \
    -pass file:"${KEY_FILE}" \
    -in "\${PLAIN}" -out "\${ENC}" \
    && rm -f "\${PLAIN}"
  echo "[sessions-backup] \$(date) Cifrado: \$(du -sh "\${ENC}" | cut -f1)"
else
  echo "[sessions-backup] \$(date) Done (sem cifra): \$(du -sh "\${PLAIN}" | cut -f1)"
fi
find "${BACKUP_DIR}" -name "sessions_*.tar.gz"     -mtime +${BACKUP_KEEP_DAYS} -delete
find "${BACKUP_DIR}" -name "sessions_*.tar.gz.enc" -mtime +${BACKUP_KEEP_DAYS} -delete
echo "[sessions-backup] \$(date) Backups mantidos (ultimos ${BACKUP_KEEP_DAYS} dias):"
ls -lh "${BACKUP_DIR}"/sessions_*.tar.gz* 2>/dev/null || echo "  (nenhum ainda)"
SCRIPT

chmod 700 /run-sessions-backup.sh

echo "${BACKUP_SCHEDULE} /run-sessions-backup.sh >> /var/log/sessions-backup.log 2>&1" > /etc/crontabs/root

echo "[sessions-backup] Agendador iniciado."
echo "[sessions-backup] Schedule : ${BACKUP_SCHEDULE}"
echo "[sessions-backup] Backups  : ${BACKUP_DIR}"
echo "[sessions-backup] Reter    : ${BACKUP_KEEP_DAYS} dias"

exec crond -f -d 8
