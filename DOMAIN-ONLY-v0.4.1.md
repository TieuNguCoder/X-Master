# X-Master v0.4.1 — v0.4 + tên miền

Bản này lấy trực tiếp v0.4.0 (`d987670a8842d85e62f1de678512962292c1769f`) làm nền. Phần Collector, DeepSeek, Buffer, gửi ảnh, tài khoản X, User Worker và 5 Account Router giữ nguyên. Không tích hợp thay đổi quản lý/chỉnh sửa hoặc cập nhật hàng loạt từ v0.5 preview.

## Cách dùng

1. Dừng Collector, thoát ứng dụng cũ, giải nén trọn ZIP và chạy X-Master.exe trên cùng tài khoản Windows. Giữ dữ liệu `%LOCALAPPDATA%\XMaster` và đúng Cloudflare account cũ.
2. Chọn **Deploy / Update Master Router**. Bước này chỉ nâng cấp Master; không cần bấm Update User Web cho web con.
3. Trong Master mở **Tên miền**, nhập `bemail2017.com`, chọn tự gắn miền cho web mới nếu muốn rồi **Lưu cấu hình miền**. Token cần quyền **Zone → Zone → Read** cho miền này, bên cạnh quyền Workers Scripts Edit đang có. Nhập token trong ứng dụng/Cloudflare; không gửi qua chat.
4. Chọn **Master Router — web mẹ**, tên `router`, bấm **Gắn / thử lại miền**. Địa chỉ web mẹ là `https://router.bemail2017.com`.
5. Chọn web con rồi gắn tên mong muốn (ví dụ `hydraairdrop`). Hoặc bấm **Chỉ gắn miền cho toàn bộ web** để gắn Master + các web con theo slug có sẵn.

Gắn miền chỉ thêm địa chỉ cho Worker hiện tại. Không upload code User Worker/Account Router, không đổi mật khẩu hoặc khóa API, không chuyển trạng thái web sang PAUSED. Collector và liên kết nội bộ giữ URL cũ; workers.dev vẫn hoạt động. DNS/SSL có thể cần thời gian cập nhật. Đăng nhập ở tên miền mới bằng mật khẩu cũ; cookie của workers.dev không chuyển sang miền mới.

Các router R1–R5 nội bộ giữ nguyên URL và luồng xử lý v0.4. Miền gốc/blog `bemail2017.com` không bị đổi.

## Nếu đã chạy bản v0.5 preview

- Không bấm lại nút **Cập nhật web cũ + gắn miền** của preview. Bản v0.4.1 không có nút đó; chỉ có thao tác gắn miền.
- Schema mới giữ và đọc được bảng miền của preview; không xóa D1, tài khoản hay khóa cũ.
- Nếu thao tác update trước đó chưa hết thời hạn, chức năng gắn miền báo chờ; không chen vào giữa lần cập nhật đang chạy.
- Web đang PAUSED do thao tác trước đó sẽ không tự Resume khi cài bản này. Kiểm tra riêng trạng thái Worker và dùng **Start Workers** khi muốn khôi phục; gắn miền không phải thao tác khôi phục.
- Gói này không tự sửa hoặc ghi đè code web con đã thay đổi trước đó.

## Lỗi và phạm vi quản lý

Lỗi gắn miền không xóa web đang chạy. Có thể thử lại tại mục Tên miền. Khi xóa web con, Master gỡ và xác minh các miền đã ghi nhận trước khi gọi chức năng xóa v0.4. Khi Stop/Start, chỉ bổ sung gỡ/gắn lại miền tương ứng; chức năng Stop/Start v0.4 được giữ nguyên. Miền thuộc Worker khác không bị ghi đè. Web cũ nằm ở Cloudflare account khác không bị di chuyển tự động.

## Kiểm thử

Có bộ kiểm tra hash so với v0.4 cho các file và hàm lõi, bộ test tên miền với SQLite thật và Cloudflare mô phỏng, cùng các test security/provisioning/runtime sẵn có của v0.4. Windows chạy PowerShell 5.1, EXE self-test và giải nén kiểm tra ZIP. CI pass không thay thế kiểm tra quyền Cloudflare, DNS/SSL và đăng nhập tại hệ thống thật. Gói này chưa tự deploy lên tài khoản của bạn.
