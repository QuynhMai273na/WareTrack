# WareTrack

Hệ thống quản lý kho hàng, bãi lưu xe và vận tải nội bộ, có dashboard 2D/3D realtime. Dự án đang ở giai đoạn **demo** (dữ liệu seed — DEC-51).

## Tài liệu

| Tài liệu | Nội dung |
|---|---|
| [Hướng dẫn sử dụng v1.0](docs/WareTrack_User_Guide_v1.0.md) | Web dùng để làm gì, vai trò nào làm gì, các quy trình thao tác từng bước — đọc trước tiên |
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

Yêu cầu: Node ≥ 24 (LTS), Docker, pnpm 9 — bật một lần bằng `corepack enable` (hoặc `npm i -g pnpm@9`). Các script gốc gọi `pnpm` lồng nhau nên cần lệnh `pnpm` có trên PATH.

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
- Kịch bản demo giống video (xe tải vào cổng, lùi dock, xếp/dỡ, rời đi): đặt `DEMO_DIRECTOR=true` trong `apps/api/.env` — API tự dựng cảnh sau khi seed và điều phối liên tục (DEC-60)
- Bản đồ mạng lưới: chọn ô site ở góc trên → **Network overview** để xem mọi site trên một bản đồ (DEC-61)

## Demo và vận hành thật (DEC-62)

| | Demo | Vận hành thật |
|---|---|---|
| Dữ liệu | `pnpm db:seed` hoặc `SEED_ON_EMPTY=true` (5 site theo video) | DB trống — không seed |
| Xe tự chạy | `DEMO_DIRECTOR=true` (tự điều phối) · `DEMO_DIRECTOR=scene` (dựng cảnh video rồi để người thật thao tác bằng các tài khoản demo) | `DEMO_DIRECTOR=false` — xe chỉ di chuyển khi có người ghi nhận (cổng, dock, xếp/dỡ) |
| Tài khoản đầu tiên | Tài khoản mẫu ở trên | `BOOTSTRAP_ADMIN_USERNAME`, `BOOTSTRAP_ADMIN_PASSWORD` (≥ 12 ký tự), tùy chọn `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_FULL_NAME` — tạo khi DB chưa có user |

Quy trình đưa một kho thật vào hệ thống (đăng nhập bằng admin → tự vào **Administration**):

1. **Sites & layouts → New site**: tạo site (có sẵn sơ đồ mẫu) → **Edit layout**: vẽ nhà kho, dock, staging, rack, ô chờ xe, trạm sạc, cổng; **Save draft** → **3D preview** → **Publish** (DEC-63).
2. **Master data**: SKU, đối tác, xe tải, tài xế. **Users & roles**: tạo user và gán vai trò theo site. **Forklifts**: đăng ký xe nâng, trạm sạc, người lái (DEC-64).
3. Trong site: **Opening stock** — nhập tồn đầu kỳ từ CSV, kiểm tra trước rồi mới ghi (DEC-65). **QR labels** — in nhãn dock/ô/pallet để dán ngoài hiện trường (DEC-66).
4. Vận hành hằng ngày: cổng (walk-in, kiểm tra giấy tờ), điều phối (gán dock), kho (nhận/xuất, tác vụ), quản lý theo dõi bản đồ 3D.

## Kiểm thử

| Lệnh | Nội dung |
|---|---|
| `pnpm typecheck` | Typecheck mọi package |
| `pnpm --filter @waretrack/api test:smoke` | 6 bộ smoke test trên API + DB thật (yard, inventory, xe lưu bãi, thiết bị + thông báo, realtime, thiết lập site / vận hành thật); tự seed lại trước mỗi bộ. Cần API đang chạy với `DEMO_DIRECTOR=false` và `SEED_VEHICLE_YARD=true` |
| `pnpm --filter @waretrack/web e2e` | Playwright e2e (tự bật Vite dev server; cần API đang chạy với dữ liệu seed) |

## Deploy demo (DEC-52, DEC-58, DEC-67 — chi tiết mục 12.7)

**API → Render.** Render Dashboard → New → Blueprint → chọn repo; [`render.yaml`](render.yaml) tạo web service Docker ([`apps/api/Dockerfile`](apps/api/Dockerfile)) ở vùng Singapore. PostgreSQL 16 đặt trên **Neon** (DEC-67): tạo project vùng Singapore, tắt *Connection pooling*, copy chuỗi kết nối trực tiếp. Nhập các secret:

- `DATABASE_URL`: chuỗi kết nối trực tiếp của Neon (có `?sslmode=require`)
- `WEB_ORIGIN`: URL web trên Vercel (ví dụ `https://waretrack.vercel.app`)
- `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`: sinh bằng `node apps/api/scripts/gen-jwt-keys.mjs`

Container tự chạy `prisma migrate deploy` và seed dữ liệu demo khi database trống. **Vận hành thật:** đặt `SEED_ON_EMPTY=false`, `DEMO_DIRECTOR=false` và thêm `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD` (secret) trước lần deploy đầu tiên. Tạo Deploy Hook trên Render rồi lưu vào secret GitHub `RENDER_DEPLOY_HOOK_URL`: workflow `api.yml` gọi hook này sau khi CI xanh trên `main`.

**Web → Vercel.** Tạo project từ repo với Root Directory = `apps/web` (build theo [`apps/web/vercel.json`](apps/web/vercel.json)), đặt biến môi trường:

- `VITE_API_BASE_URL=https://<api>.onrender.com/api/v1`
- `VITE_WS_URL=https://<api>.onrender.com`

Sau lần deploy đầu, ngắt Git integration của Vercel (Settings → Git → Disconnect) để web chỉ lên production qua CI (test xanh + duyệt). Thêm secret `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` vào environment `web-production` và `RENDER_DEPLOY_HOOK_URL` vào `api-production` trên GitHub.

**Lưu ý gói free:** API trên Render ngủ sau khoảng 15 phút không có request, lần mở đầu mất khoảng 1 phút. Database Neon free không hết hạn nhưng dung lượng nhỏ và tự ngủ khi không dùng (thức dậy trong vài trăm mili giây).
