FROM node:24-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

ENV PORT=8787 \
    DATA_DIR=/data \
    BLOB_MAX_MB=50 \
    NODE_ENV=production

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/healthz >/dev/null || exit 1

CMD ["node", "src/index.mjs"]
