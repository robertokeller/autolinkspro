FROM node:20-bookworm-slim
WORKDIR /app

COPY . .

RUN npm --prefix services/telegram-telegraph ci \
  && npm --prefix services/telegram-telegraph run build \
  && npm --prefix services/telegram-telegraph prune --omit=dev

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3112

EXPOSE 3112

CMD ["npm", "--prefix", "services/telegram-telegraph", "run", "start"]
