# WareTrack — Hướng dẫn sử dụng

Phiên bản 1.0 · dành cho người dùng mới (nhân viên kho, bảo vệ, điều phối, quản lý) và người xem demo.

Tài liệu này giải thích WareTrack dùng để làm gì, mỗi vai trò làm việc gì trên hệ thống và các bước thao tác cho từng quy trình. Phần kỹ thuật (cài đặt, kiến trúc) xem ở [README](../README.md) và [Requirements & Architecture](WareTrack_Requirements_Architecture_v1.0.md).

> Giao diện mặc định là tiếng Anh. Tên nút trong tài liệu được ghi đúng như trên màn hình, ví dụ **Gate out**. Đổi sang tiếng Việt: bấm vào tên của bạn ở góc trên bên phải, chọn mục đổi ngôn ngữ.

## Mục lục

1. [WareTrack là gì](#1-waretrack-là-gì)
2. [Các khái niệm cần biết](#2-các-khái-niệm-cần-biết)
3. [Đăng nhập và giao diện chung](#3-đăng-nhập-và-giao-diện-chung)
4. [Màn hình Tổng quan (bản đồ 3D)](#4-màn-hình-tổng-quan-bản-đồ-3d)
5. [Vai trò: ai làm gì](#5-vai-trò-ai-làm-gì)
6. [Quy trình làm việc từng bước](#6-quy-trình-làm-việc-từng-bước)
7. [Thiết lập một kho mới (quản trị)](#7-thiết-lập-một-kho-mới-quản-trị)
8. [Kịch bản thử nhanh trên bản demo](#8-kịch-bản-thử-nhanh-trên-bản-demo)
9. [Câu hỏi thường gặp](#9-câu-hỏi-thường-gặp)

---

## 1. WareTrack là gì

WareTrack là hệ thống quản lý **kho hàng, bãi xe và luồng xe tải ra vào** cho doanh nghiệp có một hoặc nhiều kho. Hệ thống giúp:

- **Biết xe tải đang ở đâu.** Xe nào sắp tới, xe nào đang ở cổng, đang lùi vào dock, đang xếp/dỡ hàng hay đã rời đi.
- **Biết hàng đang ở đâu.** Từng pallet nằm ở ô nào, bao nhiêu hàng còn có thể bán, bao nhiêu đã giữ cho đơn xuất.
- **Điều phối công việc.** Hệ thống tự tạo tác vụ (cất hàng, lấy hàng); giám sát giao việc cho người lái xe nâng và theo dõi tiến độ.
- **Quản lý nhìn toàn cảnh theo thời gian thực.** Bản đồ 3D của từng kho và của cả mạng lưới cập nhật ngay khi có người thao tác, kèm các chỉ số chính (KPI).

Mỗi thao tác ngoài hiện trường (cho xe qua cổng, quét pallet lên xe, cất hàng vào kệ) được ghi lại ngay trên hệ thống. Bản đồ 3D chỉ thể hiện những gì đã được ghi nhận: xe tải và xe nâng chỉ di chuyển khi có người thao tác (hoặc khi hệ thống demo tự chạy, xem [mục 9](#9-câu-hỏi-thường-gặp)).

## 2. Các khái niệm cần biết

| Thuật ngữ | Nghĩa |
|---|---|
| **Site** (kho) | Một địa điểm vận hành, có mã như `WH-01 Riverside Hub`. Một tài khoản có thể được phân quyền ở nhiều site. |
| **Dock / Bay** | Cửa xếp dỡ hàng của nhà kho, nơi xe tải lùi đuôi vào (ví dụ `Bay 1`). |
| **Gate** (cổng) | Nơi bảo vệ ghi nhận xe tới, kiểm tra giấy tờ và cho xe ra. |
| **Yard slot** | Ô chờ trong bãi, cho xe đã vào cổng nhưng chưa có dock. |
| **Staging** | Khu đặt tạm pallet, chờ xếp lên xe hoặc chờ cất vào kho. |
| **Storage / Rack** | Vị trí lưu trữ: kệ ngoài trời, ô trong nhà kho (ví dụ `A-001`). |
| **Pallet** (HU) | Một kiện hàng trên pallet, có mã `PAL-…` và nhãn QR. Hệ thống theo dõi từng pallet. |
| **SKU** | Mã mặt hàng (ví dụ Cardboard Box (M)). |
| **Truck visit** (lượt xe) | Một lần xe tải tới site, từ lúc đặt lịch tới lúc rời cổng. Trạng thái: *En route* (đang tới) → *At gate* (ở cổng) → *Waiting* (chờ trong bãi) / *Docking* (đang vào dock) → *At dock* / *Handling* (đang xếp/dỡ) → *Ready to leave* (sẵn sàng rời) → *Departed* (đã rời). |
| **Inbound / Outbound** | Đơn nhập hàng (nhận từ nhà cung cấp) / đơn xuất hàng (giao cho khách). |
| **Shipment** (lô hàng) | Hàng của một đơn đi trên một xe, có mã `SHP-…`. Hiển thị ở khung *Shipment Tracking*. |
| **Task** (tác vụ) | Việc cụ thể cho người hoặc xe nâng: *Put-away* (cất hàng), *Pick* (lấy hàng), *Move pallet*… |
| **Exception** (ngoại lệ) | Sự cố cần xử lý: hàng hỏng, lệch tồn, sai vị trí, xe nâng hỏng, an toàn… |

## 3. Đăng nhập và giao diện chung

### Đăng nhập

1. Mở địa chỉ web của hệ thống (bản chạy trên máy: http://localhost:5173).
2. Nhập **Username** và **Password**, bấm đăng nhập.
3. Hệ thống đưa bạn tới màn hình **Overview** của site đầu tiên bạn có quyền. Tài khoản quản trị chưa có site nào sẽ được đưa thẳng tới trang **Administration**.

Ở bản demo, màn hình đăng nhập hiện sẵn danh sách tài khoản mẫu, mật khẩu chung là `WareTrack@2026` (xem [mục 5](#5-vai-trò-ai-làm-gì)). Bản vận hành thật không hiện danh sách này.

### Thanh trên cùng

| Thành phần | Dùng để |
|---|---|
| **Logo WareTrack** (góc trái) | Mở menu các trang: Overview, Gate & Yard, Inventory, Inbound, Outbound, Tasks, Exceptions, QR labels, Opening stock, Administration. Mỗi người chỉ thấy các trang mà vai trò của mình được dùng. |
| **Ô tìm kiếm** | Tìm nhanh site, xe tải, xe nâng, pallet, lô hàng. Phím tắt `/`. |
| **Ô chọn site** | Bấm tên site để về Overview của site đó. Mũi tên bên cạnh mở danh sách site (kèm % đầy kho, số dock đang dùng) và mục **Network overview**. |
| **Live** + giờ | Trạng thái kết nối thời gian thực và giờ địa phương của site. *Reconnecting* là đang kết nối lại; *Stale since …* là dữ liệu có thể đã cũ. |
| **Chuông** | Thông báo: sự cố, thiết bị, cổng và bãi. **Mark all read** để đánh dấu đã đọc. |
| **Tên bạn** (góc phải) | Cũng mở menu các trang, kèm đổi ngôn ngữ Anh/Việt và **Sign out** (đăng xuất). |

> Mỗi tab trình duyệt dùng chung phiên đăng nhập. Muốn mở nhiều vai trò cùng lúc, hãy dùng các trình duyệt hoặc cửa sổ ẩn danh khác nhau.

## 4. Màn hình Tổng quan (bản đồ 3D)

Đây là màn hình chính của site: bản đồ 3D làm nền, các khung thông tin xếp xung quanh.

### Đọc các khung thông tin

- **Ô KPI** (góc trên trái):
  - *Stock on hand*: số pallet đang có trong kho.
  - *Trucks on site*: số xe tải đang ở trong site, kèm số xe sắp tới.
  - *On-time delivery*: tỉ lệ giao đúng hạn trong 30 ngày.
- **Panel site** (bên phải):
  - trạng thái vận hành, mức đầy kho, số dock đang bận;
  - số xe xuất trong ngày, số lần cất hàng trong ngày;
  - tồn kho các mặt hàng chính (*In Stock* / *Low Stock*);
  - đội xe nâng và việc từng xe đang làm.
- **Shipment Tracking** (dưới trái): tiến độ của một lô hàng qua các bước *Order Confirmed → Picked → Loading x/6 → In Transit → Delivered*, kèm giờ dự kiến.
- **Bảng vận hành** (dưới phải), gồm ba tab:
  - *Docks*: dock nào đang có xe, xe gì, đang làm gì, tiến độ bao nhiêu;
  - *Forklifts*: các xe nâng;
  - *Trucks*: các xe tải trong site.

### Thao tác trên bản đồ

- **Kéo chuột** để di chuyển, **lăn chuột** để phóng to/thu nhỏ.
- Cụm nút bên phải bản đồ:
  - phóng to / thu nhỏ;
  - xoay góc nhìn;
  - đặt lại góc nhìn;
  - **Home**: quay về khung nhìn của site.
- **3D / 2D**: chuyển sang sơ đồ 2D khi máy yếu. Bản 2D có đủ chức năng.
- **Bấm vào một đối tượng** (xe tải, xe nâng, pallet, dock, trạm sạc) để mở khung chi tiết. Khung chi tiết có nút mở thẳng trang nghiệp vụ liên quan. Bấm vào một xe tải đang tới sẽ hiện đường xanh dẫn tới dock đã đặt.
- **Network overview** (trong ô chọn site): thu nhỏ ra toàn bộ các site trên một bản đồ chung. Bấm nhãn tên site để bay tới site đó.

### Ý nghĩa chuyển động trên bản đồ

| Bạn thấy | Nghĩa là |
|---|---|
| Xe tải chạy theo đại lộ vào cổng | Xe đang tới. Vị trí tính theo giờ dự kiến tới (ETA). |
| Xe tải dừng ở cổng / lùi vào bay | Bảo vệ đã ghi nhận xe tới / đã cho xe vào và có dock. |
| Xe nâng chở pallet từ staging ra hông đuôi xe tải | Có người vừa quét pallet lên xe (**Load**). |
| Xe nâng chở pallet từ xe tải xuống dock | Nhân viên vừa nhận một pallet (**Record**). |
| Xe nâng chở pallet vào cửa kho / lên kệ | Tác vụ cất hàng vừa hoàn tất. |
| Xe tải chạy ra đại lộ rồi rời khỏi bản đồ | Bảo vệ vừa cho xe ra cổng (**Gate out**). |

Pallet không bao giờ tự di chuyển. Pallet chỉ đổi chỗ khi có xe nâng chở, và chỉ hiện ở chỗ mới khi xe nâng đã đặt xuống.

## 5. Vai trò: ai làm gì

Quyền được gán **theo site**: cùng một người có thể là giám sát ở WH-01 nhưng chỉ xem ở WH-02. Menu chỉ hiện các trang mà vai trò ở site đang xem được dùng.

| Vai trò | Tài khoản demo | Trang chính | Việc chính |
|---|---|---|---|
| Quản trị hệ thống (*Admin*) | `admin` — Morgan Lee | Administration | Tạo site, vẽ sơ đồ kho, tạo user và phân quyền, danh mục dùng chung, xe nâng. **Không** thao tác cổng/kho. |
| Quản lý site (*Site Manager*) | `manager` — Alex Chen (cả 5 site) | Overview + mọi trang | Theo dõi toàn cảnh, duyệt điều chỉnh tồn lớn, xử lý sự cố, thay mọi vai trò khi cần. |
| Điều phối bãi (*Yard Dispatcher*) | `dispatcher` — Sam Rivera (WH-01, WH-04) | Gate & Yard | Đặt lịch xe, gán dock, xác nhận xe đã vào dock. |
| Bảo vệ cổng (*Gate Security*) | `gate` — Jordan Park (WH-01, WH-04) | Gate & Yard | Ghi nhận xe tới, kiểm tra giấy tờ, cho vào / từ chối, cho xe ra, xe vãng lai (walk-in). |
| Giám sát kho (*Warehouse Supervisor*) | `supervisor` — Taylor Nguyen (WH-01, WH-02) | Outbound, Inbound, Tasks | Tạo đơn nhập/xuất, giao tác vụ cho người lái, niêm phong và xuất hàng (**Dispatch**). |
| Nhân viên kho (*Warehouse Operator*) | `operator` — Casey Tran (WH-01) | Inbound, Tasks | Nhận hàng từ xe tải, ghi nhận từng pallet. |
| Lái xe nâng (*Forklift Operator*) | `forklift` — Sam Haddad (WH-01) | Tasks, Outbound | Cất hàng, lấy hàng, quét pallet lên xe (**Load**). |
| Kiểm soát tồn kho (*Inventory Controller*) | `inventory` — Riley Pham (WH-01, WH-02) | Inventory | Xem tồn, đề nghị điều chỉnh, kiểm kê, nhập tồn đầu kỳ. |
| Người xem (*Viewer*) | `viewer` — Avery Do | Overview | Chỉ xem, không có nút thao tác. |

Hai quy tắc hay gặp:

- **Người lái xe nâng không tự nhận việc.** Giám sát kho (hoặc điều phối) giao tác vụ cho họ. Quy tắc này giúp điều phối kiểm soát được ai đang làm gì.
- **Người đề nghị điều chỉnh tồn không tự duyệt được.** Điều chỉnh lớn (trên 5 đơn vị hoặc 2%) cần Quản lý site duyệt.

## 6. Quy trình làm việc từng bước

Các ví dụ dưới đây dùng kho **WH-01 Riverside Hub**.

### 6.1. Xe tải vào cổng và vào dock

Trang **Gate & Yard** liệt kê các lượt xe. Mặc định chỉ hiện lượt đang hoạt động; chọn *All* để xem cả lịch sử. Bấm vào một dòng để mở chi tiết và các nút thao tác. Ô tìm kiếm cho phép tra theo biển số hoặc mã lượt xe.

| Bước | Ai | Thao tác |
|---|---|---|
| Đặt lịch (nếu chưa có) | Điều phối | **New appointment**: chọn xe, tài xế, khung giờ hẹn, chiều nhập/xuất. Muốn giữ trước dock thì dùng **Assign dock** ngay sau khi đặt lịch. |
| Xe không có lịch | Bảo vệ | **Walk-in**: tạo lượt xe ngay tại cổng. |
| Xe tới cổng | Bảo vệ | Chọn lượt xe → **Record arrival** → Confirm. Có thể ghi biển số thực tế nếu khác. |
| Kiểm tra giấy tờ | Bảo vệ | **Verify & admit** → tích đủ các mục trong *Document checklist* → Confirm. Xe có dock đặt trước sẽ chuyển sang *Docking*; chưa có thì vào bãi chờ (*Waiting*). Không đạt thì **Reject** và ghi lý do. |
| Gán dock | Điều phối | **Assign dock** → chọn dock trống. **Unassign dock** để đổi. |
| Xác nhận xe đã vào dock | Điều phối | **Confirm at dock** → quét QR hoặc gõ mã dock (ví dụ `Bay 2`) → Confirm. Xe chuyển sang *At dock*. |
| Xe xong việc, ra cổng | Bảo vệ | Lượt xe ở *Ready to leave* → **Gate out** → Confirm. Xe chuyển sang *Departed*; dock được giải phóng. |

Điều phối và quản lý có thể **Abort** để hủy một lượt xe đang dở (kèm lý do), hoặc **Cancel appointment** để hủy lịch chưa tới.

### 6.2. Nhập hàng (nhận hàng từ xe tải)

Trang **Inbound** liệt kê các đơn nhập.

1. *(Giám sát)* Đơn chưa có thì bấm **New** → *New inbound order*: chọn nhà cung cấp, ngày dự kiến nhận, gắn lượt xe (*Truck visit*), thêm dòng hàng (**Add line**: SKU, số lượng, số pallet, số lô nếu có).
2. *(Nhân viên kho)* Khi xe đã ở dock, mở đơn và bấm **Start receiving**.
3. Với mỗi pallet dỡ xuống: nhập số lượng (**Qty**), tích **Damaged** nếu hàng hỏng, bấm **Record**. Tiến độ *Received / Expected* tăng dần; trên bản đồ, xe nâng chở pallet từ xe xuống dock.
4. Đủ hàng thì bấm **Complete receipt**. Nhận thiếu thì cần người có quyền duyệt ghi lý do (*Short receipt reason*).
5. Hệ thống tự tạo tác vụ **Put-away** cho từng pallet, và xe tải chuyển sang *Ready to leave*.
6. Pallet cần kiểm tra chất lượng sẽ nằm ở mục QC. Giám sát mở mục này để duyệt.

### 6.3. Cất hàng vào kho (Put-away)

Trang **Tasks** có ba bộ lọc: *Open* (đang mở), *Mine* (việc của tôi), *Done* (đã xong).

1. *(Giám sát)* Ở thẻ **Put-away** → **Assign** → chọn người lái (ví dụ Sam Haddad), có thể chọn kèm xe nâng → Confirm.
2. *(Lái xe nâng)* Mở **Tasks** → thẻ việc của mình → **Start**.
3. **Scan source**: quét QR vị trí lấy hàng (ví dụ `Bay 2`) và mã pallet. Ô nhập có sẵn gợi ý.
4. Chở pallet tới vị trí đích, bấm **Scan destination & complete**, rồi quét QR vị trí đích (ví dụ `A-001`). Tác vụ hoàn tất; tồn kho cập nhật ngay.

Gặp vướng mắc (vị trí bị chặn, đầy, hỏng xe…) thì bấm **Report blocker**. Giám sát có thể **Cancel** tác vụ.

### 6.4. Xuất hàng

Trang **Outbound** liệt kê các đơn xuất. Bấm vào một đơn để mở chi tiết: dòng hàng, *Ordered / Allocated / Picked / Shipped*, pallet đã xếp.

1. *(Giám sát)* **New** → *New outbound order*: chọn khách hàng, thêm dòng hàng (SKU, số lượng), gắn lượt xe, hạn giao → **Confirm & allocate**. Hệ thống giữ hàng cho đơn và tạo các tác vụ **Pick**.
2. *(Giám sát)* Ở **Tasks**, giao các tác vụ Pick cho người lái.
3. *(Lái xe nâng)* Thực hiện Pick: **Start** → **Scan source** (vị trí + pallet), nhập *Quantity picked* nếu lấy lẻ → **Scan destination & complete** (ô staging). Lấy thiếu thì dùng **Short pick**.
4. Khi xe tải đã ở dock: bấm **Start loading**. Với mỗi pallet, quét mã pallet (`PAL-…`) và dock (ví dụ `Bay 1`) rồi bấm **Load**. Tiến độ *x/6 pallets* tăng; trên bản đồ xe nâng chở pallet ra xe.
5. *(Giám sát)* Xếp đủ hàng thì nhập **Seal number** (số niêm phong) → **Dispatch**. Lô hàng chuyển sang *In transit*, xe sang *Ready to leave*.
6. *(Bảo vệ)* **Gate out** cho xe ra (xem 6.1).
7. *(Giám sát / Quản lý)* Khi khách nhận hàng: **Mark delivered**.

### 6.5. Tồn kho

Trang **Inventory** có các tab:

| Tab | Dùng để |
|---|---|
| **Overview** | Tóm tắt tồn theo mặt hàng, cảnh báo *Low stock*. |
| **Balances** | Tồn chi tiết theo SKU / vị trí / pallet / lô: *On hand*, *Reserved* (đã giữ cho đơn), *available* (còn bán được). Ô tìm theo SKU, vị trí, pallet, lô. |
| **Ledger** | Lịch sử mọi giao dịch kho (nhập, xuất, chuyển, điều chỉnh), dạng *From → To*. |
| **Adjustments** | Đề nghị điều chỉnh tồn (**Request adjustment**: lượng chênh, lý do: lệch kiểm kê, hỏng, mất, tìm thấy, sửa dữ liệu) và duyệt (**Approve**). Quản lý có thể **Reverse** một giao dịch, kèm lý do. |
| **Stocktaking** | Kiểm kê: **Start** đợt kiểm, nhân viên đếm (*counted*), **Close counting**, rồi **Complete & create adjustments** để hệ thống tự tạo điều chỉnh theo số chênh. |

Bấm vào một pallet để xem *Pallet contents* (hàng trên pallet) và *History* (lịch sử di chuyển). Nút **Move** chuyển pallet sang vị trí khác; có thể quét QR vị trí đích.

### 6.6. Báo cáo và xử lý sự cố

Trang **Exceptions** có các bộ lọc *Open / Closed / All*.

1. Ai thấy sự cố thì bấm **Report incident** và chọn:
   - *Type*: an toàn, hàng hỏng, lệch kiểm kê, sai vị trí, xe nâng hỏng, xe hỏng, chênh lệch nhận hàng, lấy thiếu, khác;
   - *Severity* (mức độ);
   - đối tượng liên quan và mô tả.

   Mức **CRITICAL** gửi thông báo ngay cho mọi Quản lý của site.
2. Người xử lý bấm **Take ownership** để nhận việc.
3. Xử lý xong, chọn *Resolution code*, ghi chú, rồi **Resolve**. Báo nhầm thì **Reject (false alarm)**.

Đóng sự cố chỉ ghi lại kết quả. Việc sửa thực tế (điều chỉnh tồn, chuyển pallet, khóa hàng…) phải làm qua chức năng tương ứng.

### 6.7. Xe lưu bãi (chỉ ở site loại Vehicle yard)

Site lưu xe ô tô có thêm trang **Stored vehicles**. Quy trình:

1. **Expect a vehicle**: khai báo xe sắp tới (VIN, hãng, đời, màu, biển số).
2. **Receive** tại cổng.
3. **Inspect**: kiểm tra tình trạng, số km, mức nhiên liệu/pin, thẻ chìa khóa, ảnh.
4. **Assign slot** → **Confirm parked**: xếp xe vào ô đỗ.
5. **Request release** → **Approve release**: yêu cầu xuất xe và duyệt.
6. **Hand over** → **Gate out**: giao xe và cho ra cổng.

Quản lý có thể **Place hold** để khóa một xe không cho xuất. Mỗi xe có *VIN history*: toàn bộ lịch sử ra vào và di chuyển.

## 7. Thiết lập một kho mới (quản trị)

Đăng nhập bằng tài khoản quản trị, mở menu → **Administration**. Trang này có ba mục:
- **Sites & layouts**: site và sơ đồ kho;
- **Users & roles**: tài khoản và phân quyền;
- **Master data**: danh mục dùng chung.

Nút **Back to operations** để quay lại màn hình vận hành.

1. **Tạo site.** **Sites & layouts → New site**: nhập mã, tên, loại site (kho trung chuyển, trung tâm phân phối, kho lạnh, cross-dock, kho tự động, bãi xe…), địa chỉ, múi giờ. Site mới có sẵn một sơ đồ mẫu và tự xuất hiện trên bản đồ mạng lưới.
2. **Vẽ sơ đồ.** **Edit layout**: kéo thả trên sơ đồ 2D để đặt các thành phần:
   - nhà kho, dock (cửa xếp dỡ trên tường nhà kho);
   - staging, kệ, ô chờ xe;
   - trạm sạc, cổng, kho trong nhà.

   Sau đó:
   - **Save draft** để lưu nháp;
   - **3D preview** để xem trước;
   - **Publish** để áp dụng.

   Khi publish, mã vị trí cũ giữ nguyên tồn và nhãn QR. Vị trí còn hàng không xóa được.
3. **Danh mục.** **Master data**: mặt hàng (SKU), đối tác (khách hàng, nhà cung cấp, hãng vận tải), xe tải, tài xế. Dữ liệu này dùng chung cho mọi site.
4. **Người dùng.** **Users & roles**: tạo tài khoản, gán vai trò theo từng site, khóa/mở tài khoản, đặt lại mật khẩu.
5. **Xe nâng.** Trong danh sách site → mục xe nâng (*Forklifts*): đăng ký xe nâng, trạm sạc và người lái.
6. **Tồn đầu kỳ.** Trong site, mở menu → **Opening stock**:
   - **Download CSV template** để tải file mẫu, cột `sku,location,quantity,pallet,lot,expires`, mỗi dòng là một pallet;
   - **Choose CSV file** → **Check file**: hệ thống kiểm tra toàn bộ file trước, có dòng sai thì không ghi gì;
   - khi tất cả hợp lệ → **Import**.

   Cần vai trò Kiểm soát tồn kho hoặc Quản lý site.
7. **In nhãn QR.** Menu → **QR labels**:
   - chọn loại nhãn: dock, staging, vị trí lưu, ô chờ xe, trạm sạc, cổng, pallet;
   - chọn cỡ lớn hoặc nhỏ;
   - bấm vào nhãn không muốn in để bỏ ra → **Print**.

   Dán nhãn ngoài hiện trường. Khi quét, nhãn tự điền vào các ô quét trên màn hình cổng, bãi và tác vụ.

Xong bảy bước này, kho sẵn sàng vận hành hằng ngày theo [mục 6](#6-quy-trình-làm-việc-từng-bước).

## 8. Kịch bản thử nhanh trên bản demo

Bản demo dựng sẵn 5 kho với xe tải, xe nâng và pallet. Ở chế độ thao tác tay, cảnh đứng yên cho tới khi có người bấm. Kịch bản dưới đây chạy trọn một vòng xuất và nhập ở WH-01, khoảng 10 phút.

Mở mỗi vai trò ở một trình duyệt hoặc cửa sổ ẩn danh riêng; mật khẩu chung `WareTrack@2026`. Để một cửa sổ `manager` mở trang **Overview** để xem bản đồ thay đổi theo từng bước.

Cảnh mở đầu: TRK-2051 đang xếp hàng ở Bay 1 (2/6 pallet), TRK-2287 (Bluepeak) đang tới với Bay 2 đã đặt trước.

| # | Tài khoản | Thao tác | Trên bản đồ |
|---|---|---|---|
| 1 | `forklift` | **Outbound** → đơn #SHP-78442 → với mỗi pallet chưa xếp: nhập mã `PAL-…`, dock `Bay 1` → **Load** (tới 6/6) | Xe nâng chở từng pallet ra xe tải |
| 2 | `supervisor` | **Outbound** → #SHP-78442 → **Seal number** `SL-204511` → **Dispatch** | Lô hàng *In transit* |
| 3 | `gate` | **Gate & Yard** → TRK-2051 → **Gate out** → Confirm | Xe tải chạy ra đại lộ, rời bản đồ |
| 4 | `gate` | TRK-2287 → **Record arrival** → **Verify & admit** (tích đủ giấy tờ) | Xe vào cổng, lùi về Bay 2 |
| 5 | `dispatcher` | TRK-2287 → **Confirm at dock** → `Bay 2` | Xe *At dock* |
| 6 | `operator` | **Inbound** → đơn Bluepeak → **Start receiving** → mỗi pallet Qty `40` → **Record** → **Complete receipt** | Xe nâng chở từng pallet xuống dock |
| 7 | `supervisor` | **Tasks** → thẻ **Put-away** → **Assign** → Sam Haddad | — |
| 8 | `forklift` | **Tasks** → **Start** → **Scan source** → **Scan destination & complete** | Xe nâng chở pallet vào kho |
| 9 | `gate` | TRK-2287 → **Gate out** | Xe tải rời bản đồ |

Trong lúc đó, `inventory` mở **Inventory** để thấy tồn thay đổi; `viewer` chỉ xem được, không có nút thao tác.

## 9. Câu hỏi thường gặp

**Tôi không thấy một trang trong menu.**
Vai trò của bạn ở site đang xem không được dùng trang đó. Kiểm tra lại site đang chọn (ô chọn site), hoặc nhờ quản trị gán thêm vai trò.

**Lái xe nâng không tự nhận được tác vụ.**
Đúng quy tắc: giám sát kho hoặc điều phối giao việc (**Assign**). Người lái chỉ thực hiện việc đã được giao.

**Nút bấm báo lỗi "không đủ quyền" hoặc không có nút.**
Mỗi thao tác cần quyền riêng. Ví dụ: chỉ bảo vệ, điều phối và quản lý cho xe ra cổng; chỉ giám sát và quản lý **Dispatch**. Tài khoản `admin` lo quản trị, không có nút thao tác cổng hay kho.

**Bản đồ 3D chậm, hiện "3D đang chậm trên thiết bị này".**
Bấm **2D** (hoặc *chuyển sang 2D* trong thông báo). Bản 2D có đủ chức năng.

**Góc trên hiện *Reconnecting* hoặc *Stale since …*.**
Mất kết nối thời gian thực. Hệ thống tự kết nối lại; nếu kéo dài, tải lại trang (F5).

**Vì sao xe tải trên bản đồ không chạy dù đã tới giờ?**
Bản đồ chỉ thể hiện những gì đã được ghi nhận. Xe đứng ở cổng cho tới khi bảo vệ bấm **Record arrival**; xe nâng chỉ chạy khi có pallet thật đổi chỗ.

**Bản demo có xe tự chạy không?**
Có hai chế độ demo do người cài đặt chọn:
- **Tự chạy**: hệ thống tự điều phối liên tục như video giới thiệu;
- **Thao tác tay**: dựng cảnh mở đầu rồi đứng yên chờ người dùng bấm.

Bản vận hành thật luôn là thao tác tay. Cách bật từng chế độ xem [README](../README.md#demo-và-vận-hành-thật-dec-62).

**Làm sao đưa bản demo về cảnh ban đầu?**
Người quản lý máy chủ chạy lại lệnh seed dữ liệu demo (xem README). Thao tác này xóa mọi thay đổi đã làm trên bản demo.
