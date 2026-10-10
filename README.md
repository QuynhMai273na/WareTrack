# WareTrack

Hệ thống quản lý kho hàng, bãi lưu xe và vận tải nội bộ, có dashboard 2D/3D realtime. Dự án đang ở giai đoạn **demo** (dữ liệu seed — DEC-51).

## Tài liệu

| Tài liệu | Nội dung |
|---|---|
| [BRD v1.0](docs/WareTrack_BRD_v1.0_2026-10-10.md) | Yêu cầu nghiệp vụ baseline |
| [Requirements & Architecture](docs/WareTrack_Requirements_Architecture_v1.0.md) | Đặc tả chi tiết, kiến trúc, DB, API, realtime, 3D, roadmap; **[Decision Log](docs/WareTrack_Requirements_Architecture_v1.0.md#28-decision-log)** (mục 28) |
| [Stack v1.0](docs/WareTrack_Stack_v1.0.md) | Tech stack và quyết định công cụ |

## Cấu trúc (monorepo, pnpm workspaces — DEC-01, DEC-02)

| Thư mục | Nội dung | Deploy | Workflow |
|---|---|---|---|
| [`apps/web`](apps/web) | React 19 + Vite + Tailwind + React Three Fiber (dashboard 2D/3D) | Vercel (DEC-52) | [`web.yml`](.github/workflows/web.yml) |
| [`apps/api`](apps/api) | NestJS 11 + Prisma + PostgreSQL 16 + Socket.IO | Render, Docker (DEC-58) | [`api.yml`](.github/workflows/api.yml) |
| [`packages/shared-schemas`](packages/shared-schemas) | Zod schema / DTO / quyền dùng chung FE và BE | – | – |
| [`infrastructure/`](infrastructure) | Docker Compose cho dev (PostgreSQL, MinIO) | – | – |
| [`docs/`](docs) | Tài liệu nghiệp vụ và thiết kế | – | – |

Mỗi workflow có path filter: sửa web chỉ chạy CI/deploy web, sửa API chỉ chạy CI/deploy API; sửa `packages/shared-schemas` chạy cả hai.

## Chạy local

Yêu cầu: Node ≥ 20.19, Docker, pnpm 9 — bật một lần bằng `corepack enable` (hoặc `npm i -g pnpm@9`). Các script gốc gọi `pnpm` lồng nhau nên cần lệnh `pnpm` có trên PATH.

```bash
pnpm install
cp apps/api/.env.example apps/api/.env      # PostgreSQL dev ở cổng 5433
pnpm db:up                                  # PostgreSQL + MinIO (Docker)
pnpm db:migrate
pnpm db:seed                                # dữ liệu demo: 6 site, xe tải, xe nâng, pallet, 53 xe lưu bãi
pnpm dev                                    # API :3000 + web :5173
```

- Web: http://localhost:5173 — Swagger: http://localhost:3000/api/docs
- Tài khoản demo (mật khẩu `WareTrack@2026`): `admin`, `manager`, `dispatcher`, `gate`, `supervisor`, `operator`, `forklift`, `inventory`, `viewer`
- Kịch bản demo giống video (xe tải nhận/xuất, shipment đang load): chạy `node apps/api/prisma/seed/scenario.mjs` khi API đang chạy, sau khi seed

## Kiểm thử

| Lệnh | Nội dung |
|---|---|
| `pnpm typecheck` | Typecheck mọi package |
| `pnpm --filter @waretrack/api test:smoke` | 5 bộ smoke test trên API + DB thật (yard, inventory, xe lưu bãi, thiết bị + thông báo, realtime); tự seed lại trước mỗi bộ. Cần API đang chạy |
| `pnpm --filter @waretrack/web e2e` | Playwright e2e (tự bật Vite dev server; cần API đang chạy với dữ liệu seed) |

## Deploy demo (DEC-52, DEC-58 — chi tiết mục 12.7)

**API → Render.** Render Dashboard → New → Blueprint → chọn repo; [`render.yaml`](render.yaml) tạo PostgreSQL 16 và web service Docker ([`apps/api/Dockerfile`](apps/api/Dockerfile)). Nhập các secret:

- `WEB_ORIGIN`: URL web trên Vercel (ví dụ `https://waretrack.vercel.app`)
- `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`: sinh bằng `node apps/api/scripts/gen-jwt-keys.mjs`

Container tự chạy `prisma migrate deploy` và seed dữ liệu demo khi database trống. Tạo Deploy Hook trên Render rồi lưu vào secret GitHub `RENDER_DEPLOY_HOOK_URL`: workflow `api.yml` gọi hook này sau khi CI xanh trên `main`.

**Web → Vercel.** Tạo project từ repo với Root Directory = `apps/web` (build theo [`apps/web/vercel.json`](apps/web/vercel.json)), đặt biến môi trường:

- `VITE_API_BASE_URL=https://<api>.onrender.com/api/v1`
- `VITE_WS_URL=https://<api>.onrender.com`

Để GitHub Actions deploy, thêm secret `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`. Nếu dùng Git integration của Vercel thì có thể bỏ bước deploy trong `web.yml`.

**Lưu ý gói free:** API trên Render ngủ sau khoảng 15 phút không có request, lần mở đầu mất khoảng 1 phút; Render Postgres free hết hạn sau 30 ngày.
