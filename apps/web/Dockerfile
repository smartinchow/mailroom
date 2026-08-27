# Mailroom dashboard — build from the repo root:
#   docker build -f apps/web/Dockerfile -t mailroom-web .
# Runtime env: API_URL, ADMIN_API_TOKEN, WEB_SESSION_SECRET, ADMIN_PASSWORD
# (all server-side only; the admin token never reaches the browser).

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml package.json ./
COPY pnpm-lock.yaml* ./
COPY apps/web/package.json apps/web/
RUN if [ -f pnpm-lock.yaml ]; then \
      pnpm install --frozen-lockfile --filter @mailroom/web...; \
    else \
      pnpm install --filter @mailroom/web...; \
    fi

FROM deps AS build
COPY apps/web apps/web
RUN pnpm --filter @mailroom/web build

FROM node:22-alpine AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# Standalone output keeps the monorepo layout: server.js sits under apps/web/.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
