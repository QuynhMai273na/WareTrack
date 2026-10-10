# WareTrack Stack v1.0

| Nhóm | Công nghệ |
|---|---|
| Frontend | React 19 + TypeScript + Vite |
| 3D | Three.js + React Three Fiber v9 + Drei |
| 3D Modeling | Blender + GLB/glTF |
| UI | Tailwind CSS + shadcn/ui |
| State | Zustand + TanStack Query |
| Forms & Validation | React Hook Form + Zod |
| Data Tables | TanStack Table |
| Animation | Motion + Three.js |
| Backend | Node.js 24 LTS + NestJS + TypeScript |
| API | REST API + Swagger/OpenAPI |
| ORM | Prisma |
| Database | PostgreSQL |
| Realtime | Socket.IO + NestJS WebSocket Gateway |
| Authentication | JWT/OIDC + RBAC |
| File Storage | MinIO / S3-compatible Object Storage |
| Background Jobs | BullMQ + Redis (khi cần) |
| Architecture | Modular Monolith |
| Testing | Vitest + Playwright + Jest + Supertest |
| Deployment | Docker + Nginx + Linux |
| CI/CD | GitHub Actions |
| Monitoring | OpenTelemetry + Grafana (khi cần) |

## Quyết định bổ sung về công cụ (đã chốt 10/10/2026)

Chi tiết và lý do xem [Decision Log](WareTrack_Requirements_Architecture_v1.0.md#28-decision-log).

| DEC | Chủ đề | Quyết định |
|---|---|---|
| DEC-01 | Cấu trúc repo | `apps/web`, `apps/api`, `packages/shared-schemas`, `infrastructure/`, `docs/` |
| DEC-02 | Monorepo | pnpm workspaces; chưa dùng Turborepo |
| DEC-03 | Shared code | Một package `shared-schemas` (Zod); type suy ra bằng `z.infer` |
| DEC-04 | Validation backend + OpenAPI | Zod dùng chung FE/BE qua **nestjs-zod**; Swagger sinh từ Zod (thay class-validator) |
| DEC-05 | Background jobs / Redis | Không dùng trong MVP: một instance API, outbox relay + scheduler in-process (`@nestjs/schedule`). Bật BullMQ + Redis khi ≥ 2 instance hoặc có job nặng |
| DEC-06 | Performance test | k6 (công cụ test, không phải dependency runtime) |
| DEC-07 | Định danh | UUIDv7 cho ID nội bộ; mã nghiệp vụ dễ đọc riêng (`WH-01`, `PAL-1026`, …) |
| DEC-36, DEC-53 | Authentication | JWT với tài khoản nội bộ; OIDC để sau (hiện không có IdP doanh nghiệp) |
| DEC-47 | i18n | Tiếng Việt mặc định, tiếng Anh thứ hai |
| DEC-52, DEC-58 | Deployment giai đoạn demo | Web (`apps/web`) → **Vercel**. API (`apps/api`) → **Render** (web service Docker từ `apps/api/Dockerfile`, `render.yaml`) + Render PostgreSQL 16 — vì cần process Node chạy liên tục cho Socket.IO, outbox relay, scheduler (Vercel Functions không phù hợp). "Docker + Nginx + Linux" ở bảng trên vẫn là kiến trúc đích cho production |
| DEC-54 | Quét mã | Camera trình duyệt (Barcode Detection API, fallback ZXing) + nhập tay; tương thích máy quét HID |
| DEC-56 | 3D asset | Layout tự thiết kế; giai đoạn đầu geometry thủ tục trong code, asset Blender low-poly (GLB) sau |
