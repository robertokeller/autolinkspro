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

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV MELI_RPA_PORT=3114

EXPOSE 3114

CMD ["node", "services/mercadolivre-rpa/dist/server.js"]
