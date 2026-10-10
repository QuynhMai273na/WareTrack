# WARETRACK

**TÀI LIỆU YÊU CẦU NGHIỆP VỤ (BRD) — PHIÊN BẢN 1.0**

Ngày chốt: 10/10/2026  |  Trạng thái: Đã chốt baseline nghiệp vụ  |  Phạm vi: Một doanh nghiệp, nhiều site

Mục tiêu: Hệ thống quản lý kho hàng, kho bãi xe và hoạt động vận tải nội bộ với dashboard 3D phản ánh dữ liệu thực tế, không lấy animation làm bằng chứng nghiệp vụ.

## 1. Quyết định nghiệp vụ đã chốt

| Mã | Chủ đề | Quyết định |
|---|---|---|
| D-01 | Đối tượng | Cả hàng hóa/pallet và xe ô tô được lưu bãi |
| D-02 | Xác nhận vị trí | Kết hợp quét QR/nhập liệu và tín hiệu GPS/RFID/camera/cảm biến |
| D-03 | Đơn vị quản lý tồn | Hỗ trợ SKU, số lượng, pallet, lô, serial và VIN |
| D-04 | Tổ chức | Một doanh nghiệp quản lý nhiều site |
| D-05 | Tích hợp | Vận hành độc lập giai đoạn 1; API mở rộng về sau |

## 2. Phạm vi và mục tiêu

Phân hệ trong phạm vi: Warehouse Management (WMS), Yard Management (YMS), Vehicle Storage, Transportation Visit/Shipment, Equipment & Task, Inventory & Audit, Dashboard & 3D Operations Monitoring.

Ngoài phạm vi phát hành đầu: thanh toán/kế toán, điều độ vận tải liên tỉnh tối ưu hóa tuyến, kết nối ERP/TMS bắt buộc, điều khiển tự động phương tiện và đảm bảo định vị chính xác liên tục khi không có nguồn cảm biến.

## 3. Thuật ngữ và đối tượng quản lý

| Khái niệm | Định nghĩa / phân biệt |
|---|---|
| Site | Một kho/bãi độc lập về layout, vị trí, sức chứa và quyền thao tác. |
| Zone | Khu vực con của site: yard, warehouse, staging, quarantine, vehicle storage. |
| Storage Location | Vị trí lưu pallet/hàng, có giới hạn sức chứa và tải trọng. |
| Parking Slot | Ô đỗ dành cho xe lưu bãi hoặc xe vận tải, có năng lực chứa được cấu hình. |
| Dock / Bay | Điểm tiếp nhận hoặc xếp/dỡ; khác với ô lưu xe dài hạn. |
| Stored Vehicle | Xe ô tô được quản lý như hàng hóa/tài sản; định danh VIN. |
| Transport Truck | Phương tiện chuyên chở đến/rời site; không đồng nhất với xe lưu bãi. |
| Truck Visit | Một lượt đến site cụ thể, gắn xe, tài xế, lịch hẹn và dock. |
| Shipment | Lệnh/chuyến vận chuyển, gồm nhiều dòng hàng hoặc VIN. |
| Handling Unit | Đơn vị chứa/vận chuyển như pallet; có thể gồm nhiều SKU/lô tùy quy tắc. |
| Equipment Task | Công việc có nguồn, đích, thiết bị, người thực hiện và xác nhận. |
| Evidence | Sự kiện quét/nhập tay/cảm biến, gắn nguồn, thời điểm, độ tin cậy. |

## 4. Quy trình nghiệp vụ chuẩn

### 4.1. Gate-in / tiếp nhận xe vận tải

Scheduled → Arrived At Gate → Verified → Waiting / Assigned Dock → At Dock → Handling → Ready To Leave → Gate-out. Người thực hiện: điều phối, bảo vệ, nhân viên kho, tài xế. Check-in ghi thời gian, giấy tờ, biển số; phân dock theo sức chứa và lịch; xác nhận vật lý khi xe cập dock.

Ngoại lệ: không có lịch, sai biển số, trùng lượt đến, thiếu giấy tờ, hết ô/dock, dock bảo trì. Các ngoại lệ phải có hành động giải quyết và audit.

### 4.2. Nhập kho hàng hóa

Inbound Order → Gate/Dock Reception → Scan & Count → Quality Decision → Put-away Task → Destination Confirmation → Receipt Completion. Hàng chờ QC hoặc cách ly không được tính là available. Sai lệch thực nhận cần ghi nhận riêng và xử lý theo quyền.

### 4.3. Xuất kho hàng hóa

Outbound Order → Reserve Stock → Pick Tasks → Scan Pick → Staging → Scan Loading → Dispatch Confirmation → Gate-out. Picking, loading, xác nhận xuất và xe ra cổng là sự kiện khác nhau; chính sách ghi giảm tồn phải thống nhất và tránh ghi giảm hai lần.

### 4.4. Tiếp nhận và quản lý xe lưu bãi

Expected → Received → Inspected → Allocated Slot → Stored → Release Requested → Released → Exited. Quản lý VIN, biển số (nếu có), hình ảnh, tình trạng, giấy tờ, nhiên liệu/pin, vị trí và lịch sử dịch chuyển. Trạng thái chất lượng/điều kiện xe tách khỏi trạng thái vị trí.

### 4.5. Điều chuyển và kiểm kê

Di chuyển xe hoặc pallet: lập lệnh → xác nhận nguồn → giữ chỗ đích → thực hiện → xác nhận đích → cập nhật vị trí nguyên tử và ghi lịch sử. Kiểm kê: tạo kỳ/đợt → đếm/quét → đối chiếu → trình phê duyệt chênh lệch → ghi giao dịch điều chỉnh.

### 4.6. Xe nâng và tác vụ

Task: Pending → Assigned → In Progress → Completed; nhánh ngoại lệ Blocked/Failed/Cancelled. Mỗi thiết bị và nhân viên không nhận xung đột tác vụ đang chạy theo chính sách điều phối.

## 5. Yêu cầu chức năng và mức ưu tiên

| Mã | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-01 | Đăng nhập, phân quyền hành động và site | P0 |
| FR-02 | Quản lý site, zone, dock, parking slot, storage location | P0 |
| FR-03 | Hồ sơ xe lưu bãi và lịch sử VIN | P0 |
| FR-04 | Gate-in/gate-out, lượt vào bãi, lịch hẹn | P0 |
| FR-05 | Phân ô/dock và kiểm soát chiếm dụng | P0 |
| FR-06 | SKU, lô, serial, pallet, inventory ledger | P0 |
| FR-07 | Nhập kho, QC, put-away | P0 |
| FR-08 | Xuất kho, picking, staging, loading | P0 |
| FR-09 | Lệnh điều chuyển xe và hàng | P0 |
| FR-10 | Shipment và trạng thái giao nhận | P0 |
| FR-11 | Dashboard KPI và bảng vận hành 2D | P0 |
| FR-12 | Scene 3D, chọn đối tượng, inspector, site switch | P0 |
| FR-13 | Realtime events, mất kết nối, làm mới snapshot | P0 |
| FR-14 | Audit và nguồn bằng chứng vị trí | P0 |
| FR-15 | Quản lý xe nâng/người vận hành/tác vụ | P1 |
| FR-16 | Kiểm kê/điều chỉnh có phê duyệt | P1 |
| FR-17 | Bảo dưỡng, sự cố và kiểm tra xe lưu bãi | P1 |
| FR-18 | Thông báo và cảnh báo nghiệp vụ | P1 |
| FR-19 | Báo cáo, xuất dữ liệu | P1 |
| FR-20 | Các adapter GPS/RFID/CCTV/QR ngoại vi cụ thể | P1/P2 |
| FR-21 | Tích hợp ERP/TMS | P2 |

## 6. Quy tắc nghiệp vụ nền tảng

- BR-01: Một ô đơn sức chứa chỉ được một đối tượng chiếm hoặc giữ chỗ hợp lệ tại cùng thời điểm.
- BR-02: Không xuất vượt tồn khả dụng; available = on-hand − allocated − held theo cấu hình phân loại tồn.
- BR-03: Quản lý VIN, serial, số lô, SKU ở mức phân biệt; chống trùng theo phạm vi phù hợp.
- BR-04: Di chuyển nội bộ phải ghi nguồn, đích, chủ thể, thời điểm, lý do và bằng chứng xác nhận.
- BR-05: Mỗi lệnh nghiệp vụ phải hỗ trợ idempotency, transaction và concurrency protection.
- BR-06: Trạng thái shipment, dock, visit, xe lưu bãi và tác vụ là các state machine độc lập.
- BR-07: Không xóa cứng lịch sử giao dịch; hủy/đảo giao dịch theo quy trình.
- BR-08: Dữ liệu từ cảm biến cần lưu raw observation và phân xử trước khi thành trạng thái xác nhận.
- BR-09: Khi dữ liệu cảm biến mâu thuẫn xác nhận thủ công, tạo cảnh báo/chờ đối soát, không tự ghi đè âm thầm.
- BR-10: Nhân viên chỉ thao tác site được cấp quyền; hành động nhạy cảm cần kiểm soát phê duyệt.

## 7. Vai trò và phân quyền

| Vai trò | Nhiệm vụ |
|---|---|
| Admin | Cấu hình doanh nghiệp, site, role và quyền |
| Site Manager | Giám sát và phê duyệt tại site được giao |
| Yard Dispatcher | Lập lịch, phân dock, ô và điều phối phương tiện |
| Gate Security | Xác nhận gate-in/out và giấy tờ |
| Warehouse Supervisor | Duyệt/tổ chức nhập xuất và nhiệm vụ |
| Warehouse Operator | Quét nhận, đếm, pick, load và put-away |
| Forklift Operator | Thực hiện tác vụ xe nâng |
| Inventory Controller | Kiểm kê và đề nghị xử lý chênh lệch |
| Viewer | Xem dữ liệu theo phân quyền |

## 8. Trạng thái & nguồn dữ liệu

| Đối tượng | Trạng thái điển hình |
|---|---|
| Truck Visit | Scheduled, AtGate, Waiting, Docked, Handling, ReadyExit, Exited, Cancelled |
| Stored Vehicle | Expected, Received, Stored, ReleasePending, Released, Exited |
| Slot | Available, Reserved, Occupied, Blocked |
| Dock | Available, Reserved, Occupied, OutOfService |
| Shipment | Confirmed, Picking, Staged, Loading, Dispatched, Delivered, Cancelled |
| Equipment Task | Pending, Assigned, InProgress, Completed, Blocked, Failed, Cancelled |
| Stock | Available, Reserved, Quarantine, Damaged |

Nguồn vị trí được gắn nhãn: CONFIRMED_MANUAL, CONFIRMED_SCAN, SENSOR_OBSERVED, INFERRED/ESTIMATED. Thời gian cập nhật và nguồn xác thực hiển thị trong inspector; không biến nội suy animation thành vị trí thực tế.

## 9. Dashboard và 3D Operations Monitoring

Bố cục theo video tham chiếu: top bar với site switcher/search/live clock; KPI stock/trucks/on-time; scene isometric; inspector theo site/truck/forklift/bay/xe lưu; shipment stepper; operations table; camera fly-to và selection bracket. Mỗi site có layout riêng và chuyển site phải đồng thời chuyển context API và scene.

Dữ liệu 3D là projection của backend: đối tượng trong scene có business ID, object type và mapped coordinates. Animation minh họa khoảng chuyển trạng thái; chuyển trạng thái nghiệp vụ yêu cầu bằng chứng hợp lệ. Giao diện 2D phải đủ chức năng ngay cả khi 3D không khả dụng.

KPI phải định nghĩa đơn vị rõ: stock pallets/units/vehicles riêng; occupancy của dock, parking slots và rack riêng; các số xe đến, xe tại site, xe sắp rời không được tính trùng.

## 10. Non-functional requirements (mục tiêu ban đầu)

| Nhóm | Mục tiêu / yêu cầu kiểm thử |
|---|---|
| Hiệu năng | API phổ biến p95 < 500 ms dưới workload đã định nghĩa |
| Độ trễ realtime | Event tới client mục tiêu 1–3 giây trong kết nối ổn định |
| 3D | Mục tiêu 30–60 FPS tại cấu hình máy kiểm thử đủ khả năng |
| Bảo mật | HTTPS, site-scoped RBAC, server authorization, audit |
| Toàn vẹn | Không nhân đôi giao dịch khi retry; không tồn âm bất hợp lệ; lock/transaction |
| Phục hồi | Backup và thử nghiệm restore định kỳ; xác định RPO/RTO sau |
| Khả dụng | Có UI 2D, trạng thái offline/stale rõ ràng |
| Quan sát | Logs, metrics, trace, event correlation ID |

## 11. Acceptance criteria cấp sản phẩm

- AC-01: Người dùng site WH-01 không thể xem/sửa dữ liệu site khác nếu thiếu quyền.
- AC-02: Không thể cấp cùng ô đơn sức chứa cho hai xe kể cả khi hai người cùng thao tác.
- AC-03: Nhập 6 pallet nhưng mới quét 3 pallet thì chỉ có 3 đơn vị thực nhận hợp lệ ở trạng thái tương ứng.
- AC-04: Scan/chứng từ bất nhất sinh phiếu xử lý ngoại lệ, không âm thầm điều chỉnh.
- AC-05: Click đối tượng 3D và click bảng 2D đều mở cùng inspector, đúng business ID.
- AC-06: Event realtime làm thay đổi KPI, inspector, tiến độ theo cùng state; refresh tái dựng đúng trạng thái từ backend.
- AC-07: Mất SignalR hiển thị trạng thái không còn live và có thể đồng bộ snapshot sau reconnect.
- AC-08: Lịch sử xe, pallet và thay đổi vị trí truy vết được thời điểm, người/nguồn và hành động.
- AC-09: Check-out không thành công nếu còn điều kiện chặn theo quy trình.
- AC-10: Các thao tác kho/bãi chính có thể vận hành bằng giao diện 2D độc lập với scene.

## 12. Các thông số cấu hình và rủi ro còn mở

Đây không phải là các lựa chọn phạm vi chưa chốt, mà là thông số cần xác định ở solution design hoặc UAT từng site: số lượng site, diện tích/sức chứa, kiểu SKU, phương pháp FIFO/FEFO, thời điểm giảm tồn khi outbound, SLA chi tiết, loại thiết bị camera/RFID/GPS, phương án mất mạng, quy tắc phê duyệt và giới hạn hiệu suất.

Rủi ro chính: tín hiệu cảm biến sai/thiếu; tọa độ 3D không tương ứng layout thực; trùng thao tác đồng thời; định danh VIN/serial nhập lỗi; quá nhiều 3D objects ảnh hưởng FPS; xung đột giữa sự kiện realtime và snapshot. Phải có chính sách reconciliation và audit.

## 13. Phê duyệt baseline và bàn giao bước 2

BRD v1.0 chốt năm quyết định D-01 đến D-05 và phạm vi chức năng nêu trên. Các chi tiết còn mở ở mục 12 là đầu vào thiết kế/kịch bản nghiệm thu, không làm thay đổi bản chất dự án. Mọi thay đổi ngoài baseline cần lập change request và tăng phiên bản BRD.

Đầu ra cho bước 2: ERD logical/physical, domain model, state machines, API contract, authorization matrix, event schema, 3D coordinate mapping và deployment architecture.
