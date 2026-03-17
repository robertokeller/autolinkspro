FROM node:20-bookworm-slim
WORKDIR /app

COPY . .

RUN npm --prefix services/whatsapp-baileys ci \
  && npm --prefix services/whatsapp-baileys run build \
  && npm --prefix services/whatsapp-baileys prune --omit=dev

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3111

EXPOSE 3111

CMD ["npm", "--prefix", "services/whatsapp-baileys", "run", "start"]
