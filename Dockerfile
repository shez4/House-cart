# House-cart — small Node + Express app backed by Postgres.
FROM node:22-slim

WORKDIR /app

# Install production deps first for better layer caching.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
# Data lives in Postgres (POSTGRES_URL) and receipt photos in Blob storage,
# so the container itself is stateless.

EXPOSE 3000
CMD ["node", "--no-warnings", "server.js"]
