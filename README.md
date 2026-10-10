# WareTrack

Hệ thống quản lý kho hàng, kho bãi xe và vận tải nội bộ (xem [BRD](docs/WareTrack_BRD_v1.0_2026-10-10.md)).

## Cấu trúc (monorepo)

| Thư mục | Nội dung | Workflow deploy |
|---|---|---|
| [`ui/`](ui/) | Giao diện (dashboard 2D + 3D) | [`ui.yml`](.github/workflows/ui.yml) |
| [`be/`](be/) | Backend API + realtime | [`be.yml`](.github/workflows/be.yml) |
| [`docs/`](docs/) | Tài liệu nghiệp vụ / thiết kế | – |

Cả UI và BE nằm chung một repo, push một lần. Mỗi workflow có path filter nên
sửa `ui/**` chỉ deploy UI, sửa `be/**` chỉ deploy BE; cũng có thể chạy tay
(`workflow_dispatch`) cho từng phần.
