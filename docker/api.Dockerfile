FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY services/api/package*.json ./
RUN npm ci

COPY services/api/ .
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3116

EXPOSE 3116

CMD ["node", "dist/index.js"]
