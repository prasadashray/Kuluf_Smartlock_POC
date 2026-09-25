# Build context: repository root (the simulator image reuses this one and imports server/src/protocol).
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY dashboard/package.json dashboard/package.json
RUN npm ci --omit=dev --workspace server
COPY server server
COPY simulator simulator
WORKDIR /app/server
EXPOSE 6808 3000
CMD ["node", "src/index.js"]
