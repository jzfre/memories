# Memories MCP gateway — HTTP transport image (for the ChatGPT connector / remote clients).
# Build context is the REPO ROOT (the gateway is a pnpm-workspace package).
FROM node:22-slim

# openssl + ca-certificates are required by Prisma's query engine at runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app

# Install workspace deps faithfully. node_modules/.git are excluded via .dockerignore.
COPY . .
RUN pnpm install --frozen-lockfile

# Generate the Prisma client for this (linux) platform.
RUN pnpm --filter @memories/memory-gateway exec prisma generate

WORKDIR /app/apps/memory-gateway
EXPOSE 8788

# On start: apply migrations, (re)index the mounted vault, then serve the HTTP MCP transport.
# MCP_HTTP_HOST must be 0.0.0.0 inside the container (Docker publishes the port to the host's loopback).
CMD ["sh", "-c", "pnpm db:migrate && pnpm scan && pnpm mcp:http"]
