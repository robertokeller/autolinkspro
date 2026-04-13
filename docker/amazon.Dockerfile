FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY services/amazon-affiliate/package*.json ./services/amazon-affiliate/
RUN npm --prefix services/amazon-affiliate ci

COPY services/amazon-affiliate/ ./services/amazon-affiliate/
RUN npm --prefix services/amazon-affiliate run build \
  && npm --prefix services/amazon-affiliate prune --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

COPY --from=build /app/services/amazon-affiliate/dist ./services/amazon-affiliate/dist
COPY --from=build /app/services/amazon-affiliate/node_modules ./services/amazon-affiliate/node_modules
COPY --from=build /app/services/amazon-affiliate/package.json ./services/amazon-affiliate/package.json

RUN chown -R node:node /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3117

USER node
EXPOSE 3117

CMD ["node", "services/amazon-affiliate/dist/server.js"]
