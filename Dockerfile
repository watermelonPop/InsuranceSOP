FROM node:20-slim AS web-build
WORKDIR /app/web
COPY web/package.json ./
RUN npm install
COPY web/ ./
RUN npm run build

FROM node:20-slim AS server-build
WORKDIR /app/server
COPY server/package.json ./
RUN npm install
COPY server/ ./
COPY fixtures /app/fixtures
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
ENV FIXTURES_DIR=/app/fixtures
ENV WEB_DIST_DIR=/app/web-dist
COPY --from=server-build /app/server/package.json ./
RUN npm install --omit=dev
COPY --from=server-build /app/server/dist ./dist
COPY --from=web-build /app/web/dist ./web-dist
COPY fixtures ./fixtures

EXPOSE 4000
CMD ["node", "dist/api/server.js"]
