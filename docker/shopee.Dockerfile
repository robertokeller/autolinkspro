FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY services/shopee-affiliate/package*.json ./services/shopee-affiliate/
RUN npm --prefix services/shopee-affiliate ci

COPY services/shopee-affiliate/ ./services/shopee-affiliate/
RUN npm --prefix services/shopee-affiliate run build \
  && npm --prefix services/shopee-affiliate prune --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

COPY --from=build /app/services/shopee-affiliate/dist ./services/shopee-affiliate/dist
COPY --from=build /app/services/shopee-affiliate/node_modules ./services/shopee-affiliate/node_modules
COPY --from=build /app/services/shopee-affiliate/package.json ./services/shopee-affiliate/package.json

RUN chown -R node:node /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3113

USER node
EXPOSE 3113

CMD ["node", "services/shopee-affiliate/dist/server.js"]
