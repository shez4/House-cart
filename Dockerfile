# House-cart — small Node + Express app with a built-in SQLite database.
# node:22-slim ships Node with the built-in node:sqlite module, so there's
# no native build step.
FROM node:22-slim

WORKDIR /app

# Install production deps first for better layer caching.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
# Database + uploaded receipt images live here; mount a persistent volume at
# this path so data survives restarts and redeploys.
ENV HOUSECART_DATA_DIR=/data

EXPOSE 3000
CMD ["node", "--no-warnings", "server.js"]
