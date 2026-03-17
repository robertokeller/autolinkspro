FROM node:20-bookworm-slim
WORKDIR /app

COPY services/ops-control ./services/ops-control

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3115

EXPOSE 3115

CMD ["node", "services/ops-control/src/server.mjs"]
