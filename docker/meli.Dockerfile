FROM mcr.microsoft.com/playwright:v1.58.2-jammy AS build
WORKDIR /app

COPY services/mercadolivre-rpa/package*.json ./services/mercadolivre-rpa/
RUN npm --prefix services/mercadolivre-rpa ci

COPY services/mercadolivre-rpa/ ./services/mercadolivre-rpa/
RUN npm --prefix services/mercadolivre-rpa run build \
  && npm --prefix services/mercadolivre-rpa prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.58.2-jammy AS runtime
WORKDIR /app

COPY --from=build /app/services/mercadolivre-rpa/dist ./services/mercadolivre-rpa/dist
COPY --from=build /app/services/mercadolivre-rpa/node_modules ./services/mercadolivre-rpa/node_modules
COPY --from=build /app/services/mercadolivre-rpa/package.json ./services/mercadolivre-rpa/package.json
COPY docker/meli-entrypoint.sh /usr/local/bin/meli-entrypoint.sh

# Pre-create the sessions directory with correct ownership so the Docker volume
# mount (meli_sessions:/app/services/mercadolivre-rpa/.sessions) inherits it.
# Without this pwuser cannot write session files → sessions lost on every restart.
RUN mkdir -p /app/services/mercadolivre-rpa/.sessions \
  && apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/* \
  && chmod +x /usr/local/bin/meli-entrypoint.sh \
  && chown -R pwuser:pwuser /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV MELI_RPA_PORT=3114

EXPOSE 3114

# Security: entrypoint starts as root only to fix volume ownership, then drops to pwuser via gosu.
ENTRYPOINT ["/usr/local/bin/meli-entrypoint.sh"]

CMD ["node", "services/mercadolivre-rpa/dist/server.js"]
