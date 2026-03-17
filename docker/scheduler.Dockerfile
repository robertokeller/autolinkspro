FROM node:20-bookworm-slim
WORKDIR /app

COPY scripts/dispatch-scheduler.mjs ./scripts/dispatch-scheduler.mjs

ENV NODE_ENV=production

CMD ["node", "scripts/dispatch-scheduler.mjs"]
