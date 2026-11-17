# Graft server: one container, SQLite metadata + content-addressed blobs on a volume.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY test ./test
COPY bench ./bench
RUN npx tsc -p tsconfig.json && npm run bundle:mcp && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production \
    GRAFT_DATA=/data \
    GRAFT_HOST=0.0.0.0 \
    PORT=7070
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/plugin ./plugin
LABEL org.opencontainers.image.title="graft" \
      org.opencontainers.image.description="Agent-first, server-side source control" \
      org.opencontainers.image.licenses="MIT"
COPY package.json ./
COPY bin ./bin
COPY web ./web
# The server runs as the unprivileged `node` user; it must own its data directory.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 7070
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7070)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "bin/graft-server.js"]
