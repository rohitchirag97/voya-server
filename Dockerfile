FROM oven/bun:1.3.5
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
# Migrations + seeds are idempotent, so run them on every start.
CMD ["sh", "-c", "bun src/db/migrate.ts && exec bun src/index.ts"]
