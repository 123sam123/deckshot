# DECKSHOT — single image serving both the game client and the WebSocket server
# on one port, so one URL is all you need to send a friend.

FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.server.json vite.config.ts ./
COPY shared ./shared
COPY client ./client
COPY server ./server

RUN npm run build

# ---------------------------------------------------------------------------

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist

# The server reads PORT and serves dist/public plus /ws on it.
ENV PORT=8080
EXPOSE 8080

# Run as a non-root user.
USER node

CMD ["node", "dist/server/src/index.js"]
