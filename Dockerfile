# Сервер LiveDub для VPS: распознавание Yandex SpeechKit для расширения (WebSocket ⇄ gRPC).
# Ключи и токены приходят через env_file при запуске, в образ не попадают.
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY server.js yandex-stt.js access.js ./
COPY proto ./proto
COPY public ./public

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "server.js"]
