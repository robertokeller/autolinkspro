FROM alpine:3.19

RUN apk add --no-cache tar

COPY docker/sessions-backup-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

VOLUME ["/data", "/backups"]

ENTRYPOINT ["/entrypoint.sh"]
