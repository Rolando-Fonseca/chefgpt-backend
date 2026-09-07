FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---

FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

VOLUME /data

ENV NODE_ENV=production
ENV DATABASE_PATH=/data/chefgpt.db

EXPOSE 3000

CMD ["node", "dist/main.js"]
