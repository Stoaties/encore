# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY shared shared
COPY server server
COPY web web
RUN npm run build

# the server is a single esbuild bundle, so the runtime image carries no node_modules
FROM node:22-alpine
ENV NODE_ENV=production \
    WEB_DIST=/app/web/dist \
    PORT=8080
WORKDIR /app
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/drizzle server/drizzle
COPY --from=build /app/web/dist web/dist
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "server/dist/index.js"]
