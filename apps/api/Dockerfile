FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/api/package.json apps/api/
RUN pnpm install --filter @mailroom/api --frozen-lockfile || pnpm install --filter @mailroom/api
COPY apps/api apps/api
RUN cd apps/api && pnpm prisma generate && pnpm build

FROM node:22-alpine
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/api/node_modules apps/api/node_modules
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/prisma apps/api/prisma
COPY --from=build /app/apps/api/package.json apps/api/
WORKDIR /app/apps/api
EXPOSE 3000
# Run migrations then serve. prisma CLI is a devDep; use the pinned dlx version.
CMD ["sh", "-c", "npx -y prisma@6 migrate deploy && node dist/index.js"]
