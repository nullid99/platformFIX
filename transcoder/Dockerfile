# HLS transcoder for LiveKit recordings — runs on the stream server next to MinIO (see README.md).
# Node 24 runs the TypeScript sources directly (type stripping), so there is no build step.
FROM node:24-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
USER node
CMD ["node", "src/worker.ts"]
