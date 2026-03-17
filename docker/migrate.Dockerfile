FROM postgres:16-alpine

COPY docker/migrate-entrypoint.sh /migrate.sh
COPY database/migrations/ /migrations/

RUN chmod +x /migrate.sh

ENTRYPOINT ["/migrate.sh"]
