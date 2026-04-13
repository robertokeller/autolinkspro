FROM node:20-bookworm-slim
WORKDIR /app

COPY services/ops-control ./services/ops-control

RUN apt-get update \
	&& apt-get install -y --no-install-recommends docker.io \
	&& rm -rf /var/lib/apt/lists/*

# Ensure the node user can write .ops/ config and log files at runtime.
RUN chown -R node:node /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3115

USER node
EXPOSE 3115

CMD ["node", "services/ops-control/src/server.mjs"]
