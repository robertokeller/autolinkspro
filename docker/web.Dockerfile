FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Root build script runs `svc:api:build`; install API workspace deps in image
# to avoid missing module/type errors on clean CI/CD builders (Coolify).
RUN npm --prefix services/api install

ARG VITE_API_URL
ARG VITE_BROWSER_RUNTIME_ENABLED=false
# NOTE: VITE_ build args are inlined into the browser JS bundle and visible
# to anyone who inspects the built JS. Only include non-sensitive, public config here.
# Microservice internal URLs (WhatsApp, Telegram, Shopee, Meli, Amazon, ops-control)
# must NEVER be VITE_ variables — they reveal internal service topology and must stay
# server-side only (configured in the `api` service environment, not here).
# WEBHOOK_SECRET and OPS_CONTROL_TOKEN must NEVER be VITE_ variables either.

ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_BROWSER_RUNTIME_ENABLED=${VITE_BROWSER_RUNTIME_ENABLED}

RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts/serve-dist.mjs ./scripts/serve-dist.mjs

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

USER node
EXPOSE 3000

CMD ["node", "scripts/serve-dist.mjs"]
