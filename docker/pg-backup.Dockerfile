FROM postgres:16-alpine

COPY docker/pg-backup-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

VOLUME ["/backups"]

ENTRYPOINT ["/entrypoint.sh"]
