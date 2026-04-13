FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY services/whatsapp-baileys/package*.json ./services/whatsapp-baileys/
RUN npm --prefix services/whatsapp-baileys ci

COPY services/whatsapp-baileys/ ./services/whatsapp-baileys/
RUN npm --prefix services/whatsapp-baileys run build \
  && npm --prefix services/whatsapp-baileys prune --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

COPY --from=build /app/services/whatsapp-baileys/dist ./services/whatsapp-baileys/dist
COPY --from=build /app/services/whatsapp-baileys/node_modules ./services/whatsapp-baileys/node_modules
COPY --from=build /app/services/whatsapp-baileys/package.json ./services/whatsapp-baileys/package.json

RUN mkdir -p /data/wa-sessions && chown -R node:node /app /data

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3111

USER node
EXPOSE 3111

CMD ["node", "services/whatsapp-baileys/dist/server.js"]
