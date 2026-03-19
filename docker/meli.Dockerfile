FROM mcr.microsoft.com/playwright:v1.58.2-jammy
WORKDIR /app

COPY . .

RUN npm --prefix services/mercadolivre-rpa ci \
  && npm --prefix services/mercadolivre-rpa run build \
  && npm --prefix services/mercadolivre-rpa prune --omit=dev

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV MELI_RPA_PORT=3114

EXPOSE 3114

CMD ["npm", "--prefix", "services/mercadolivre-rpa", "run", "start"]
