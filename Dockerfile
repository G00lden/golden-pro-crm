FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY --chown=node:node . .
RUN npm run build && mkdir -p .runtime .wa-session && chown -R node:node /app/.runtime /app/.wa-session

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]
