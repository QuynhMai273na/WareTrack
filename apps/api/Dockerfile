# WareTrack API — image cho Render (DEC-58). Build context = gốc monorepo:
#   docker build -f apps/api/Dockerfile -t waretrack-api .
# Hai tầng: "build" có đủ công cụ (pnpm, TypeScript, dependency dev); "runtime" chỉ chứa code đã build và
# dependency production (gồm prisma CLI cho migration, tsx cho seed demo) — không npm / pnpm / corepack,
# chạy bằng user thường. Ít gói hơn = ít lỗ hổng hơn (Trivy quét image này trong CI).

# Node 24 LTS (Krypton). Node 25+ không còn kèm Corepack — đổi major thì kiểm tra bước `corepack enable`
FROM node:24.21-bookworm-slim AS build

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

# Bản cài độc lập chỉ gồm dependency production của API (shared-schemas được chép vào như một gói thường);
# dist bị .gitignore nên chép riêng; Prisma Client sinh lại cho bản cài này
RUN pnpm --filter @waretrack/api --prod deploy /out \
  && cp -r apps/api/dist /out/dist \
  && cd /out && node_modules/.bin/prisma generate

FROM node:24.21-bookworm-slim AS runtime

# Cập nhật bản vá bảo mật của Debian; bỏ npm / corepack / yarn đi kèm image gốc — API không dùng khi chạy
RUN apt-get update && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3000
# migrate deploy → (tùy chọn) seed demo khi DB trống → chạy API
CMD ["sh", "scripts/start.sh"]
