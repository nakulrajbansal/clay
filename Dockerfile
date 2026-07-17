# Clay — single-container deploy: the backend serves the API AND the built
# shell (same-origin, so session cookies just work).
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY specs ./specs
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @clay/shell build

FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY --from=build /app ./
ENV NODE_ENV=production
ENV PORT=8080
ENV STATIC_DIR=packages/shell/dist
EXPOSE 8080
CMD ["pnpm", "--filter", "@clay/backend", "exec", "tsx", "src/server.ts"]
