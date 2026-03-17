FROM node:20-bookworm-slim
WORKDIR /app

COPY . .

RUN npm --prefix services/shopee-affiliate ci \
  && npm --prefix services/shopee-affiliate run build \
  && npm --prefix services/shopee-affiliate prune --omit=dev

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3113

EXPOSE 3113

CMD ["npm", "--prefix", "services/shopee-affiliate", "run", "start"]
