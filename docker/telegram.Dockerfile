FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY services/telegram-telegraph/package*.json ./services/telegram-telegraph/
RUN npm --prefix services/telegram-telegraph ci

COPY services/telegram-telegraph/ ./services/telegram-telegraph/
RUN npm --prefix services/telegram-telegraph run build \
  && npm --prefix services/telegram-telegraph prune --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

COPY --from=build /app/services/telegram-telegraph/dist ./services/telegram-telegraph/dist
COPY --from=build /app/services/telegram-telegraph/node_modules ./services/telegram-telegraph/node_modules
COPY --from=build /app/services/telegram-telegraph/package.json ./services/telegram-telegraph/package.json
COPY docker/telegram-entrypoint.sh /usr/local/bin/telegram-entrypoint.sh

RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/* \
  && chmod +x /usr/local/bin/telegram-entrypoint.sh \
  && mkdir -p /data/tg-sessions \
  && chown -R node:node /app /data

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3112

EXPOSE 3112

ENTRYPOINT ["/usr/local/bin/telegram-entrypoint.sh"]
CMD ["node", "services/telegram-telegraph/dist/server.js"]
