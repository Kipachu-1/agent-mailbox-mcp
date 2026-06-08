FROM oven/bun:1.3.9-slim AS base
WORKDIR /app

FROM base AS install
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS runtime
ENV NODE_ENV=production
ENV AGENT_MAILBOX_HTTP_HOST=0.0.0.0

COPY --from=install /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src

EXPOSE 8137
CMD ["bun", "run", "http"]
