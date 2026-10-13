# WareTrack API — image cho Render (DEC-58). Build context = gốc monorepo:
#   docker build -f apps/api/Dockerfile -t waretrack-api .
FROM node:26.10-bookworm-slim

# Prisma engine cần OpenSSL
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo

# Cài dependency trước (tận dụng cache layer) — chỉ API và gói dùng chung
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared-schemas/package.json packages/shared-schemas/
RUN pnpm install --frozen-lockfile --filter "@waretrack/api..."

COPY packages/shared-schemas packages/shared-schemas
COPY apps/api apps/api
RUN pnpm --filter @waretrack/shared-schemas build \
  && pnpm --filter @waretrack/api exec prisma generate \
  && pnpm --filter @waretrack/api build

ENV NODE_ENV=production
WORKDIR /repo/apps/api
EXPOSE 3000
# migrate deploy → (tùy chọn) seed demo khi DB trống → chạy API
CMD ["sh", "scripts/start.sh"]
