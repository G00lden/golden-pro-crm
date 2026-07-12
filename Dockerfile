FROM node:22-slim AS build

ARG BUILD_COMMIT=unknown
ARG VITE_DATA_PROVIDER=sqlite
ARG VITE_DB_PROVIDER=sqlite
ARG VITE_LOCAL_AUTH=false
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
ENV BUILD_COMMIT=$BUILD_COMMIT
ENV VITE_DATA_PROVIDER=$VITE_DATA_PROVIDER
ENV VITE_DB_PROVIDER=$VITE_DB_PROVIDER
ENV VITE_LOCAL_AUTH=$VITE_LOCAL_AUTH
RUN npm run build

FROM node:22-slim AS runtime

WORKDIR /app

COPY package*.json ./
# Firebase Admin declares Storage and Firestore as optional. The CRM uses
# Firestore but not Storage, so Firestore is a direct dependency and optional
# packages are omitted from the runtime image.
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-server ./dist-server
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/release.json ./release.json
COPY --from=build --chown=node:node /app/firebase-applet-config.json ./firebase-applet-config.json

RUN mkdir -p data .runtime .wa-session && chown -R node:node /app/data /app/.runtime /app/.wa-session

ARG BUILD_COMMIT=unknown
ENV NODE_ENV=production
ENV ENABLE_VITE_DEV_SERVER=false
ENV BUILD_COMMIT=$BUILD_COMMIT
ENV PORT=8080

EXPOSE 8080

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist-server/server.mjs"]
