FROM alpine:3.19

RUN apk add --no-cache tar openssl

# Security: run as non-root user so session volumes are not writable by UID 0
RUN addgroup -S backup && adduser -S -G backup backup

COPY docker/sessions-backup-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

VOLUME ["/data", "/backups"]

# Ensure the backup output directory is owned by the backup user
RUN mkdir -p /backups && chown -R backup:backup /backups

USER backup

ENTRYPOINT ["/entrypoint.sh"]
