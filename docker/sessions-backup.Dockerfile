FROM alpine:3.19

RUN apk add --no-cache tar openssl

# Create a dedicated user (kept for file ownership compatibility).
RUN addgroup -S backup && adduser -S -G backup backup

COPY docker/sessions-backup-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

VOLUME ["/data", "/backups"]

# Keep backup directory writable and run as root because busybox `crond`
# is not reliable as non-root on Alpine in this setup. Session volumes are
# mounted read-only in docker-compose.
RUN mkdir -p /backups && chown -R root:root /backups

ENTRYPOINT ["/entrypoint.sh"]
