# X-Master v0.5.0 — web mẹ, web con và tên miền

## Nâng cấp bản đang dùng

1. Dừng Collector, thoát X-Master cũ. Giải nén toàn bộ ZIP mới vào một thư mục riêng; chạy `X-Master.exe` trên cùng tài khoản Windows. Giữ nguyên dữ liệu `%LOCALAPPDATA%\XMaster` để ứng dụng đọc cấu hình và phiên Telegram cũ.
2. Chọn **Deploy / Update Master Router**, dùng đúng Cloudflare Account ID hiện tại. Script tái sử dụng D1 `x-master`, áp dụng schema bổ sung và giữ `MASTER_KEY`/`SESSION_PEPPER` đang có. Không đổi tài khoản Cloudflare trong lúc nâng cấp.
3. Mở Master Web, vào **Tên miền**, nhập `bemail2017.com`, bật **Tự gắn miền khi tạo web mới**, rồi **Lưu và kiểm tra miền**. Token Master cần quyền **Zone → Zone → Read** cho đúng zone, ngoài quyền Workers Scripts Edit và D1 đang dùng khi deploy. Nhập token trực tiếp trong ứng dụng hoặc Cloudflare Secrets; không gửi qua chat.
4. Bấm **Cập nhật web cũ + gắn miền**. Mỗi web được xử lý lần lượt. Web đang tạm dừng vẫn tạm dừng; dùng **Resume** khi muốn chạy lại. Tiến trình báo riêng web nào cần thử lại.
5. Chạy lại Collector. Mở URL web con, đăng nhập và kiểm tra tài khoản/kênh đã giữ nguyên. DNS và chứng chỉ SSL mới có thể cần thời gian cập nhật sau khi API xác nhận gắn miền.

Miền gốc `bemail2017.com` và Worker blog `tieungummo-demo` không bị thay đổi. Mỗi web con dùng một subdomain trực tiếp, ví dụ `khach01.bemail2017.com`. Master tìm zone đang active trên đúng Cloudflare account; không cần nhập Zone ID.

## Các thao tác mới

- **Chỉnh sửa**: tên hiển thị, gắn/đổi subdomain, đổi Cloudinary hoặc DeepSeek. Ô khóa để trống giữ giá trị cũ. API không trả khóa cũ về trình duyệt.
- **Chỉnh sửa tài khoản**: tên X, username, Buffer Channel ID/token, kênh Telegram, ngôn ngữ, loại bài, Premium và bật/tắt tài khoản.
- **Update User Web**: cập nhật code cho web và router hiện tại; giữ Worker name, tài khoản X, nguồn và khóa. Web rất cũ thiếu tên Worker sẽ dùng tên từ URL workers.dev đang lưu.
- **Gắn / thử lại miền**: gắn miền theo slug cho web cũ hoặc thử lại đồng bộ miền đã cấu hình. Muốn một tên cụ thể, dùng **Chỉnh sửa**.
- **Dừng / Resume**: chặn dispatch, tắt/khôi phục workers.dev, Preview, Cron và gỡ/gắn lại miền do Master quản lý.
- **Xóa**: xác minh Worker thuộc đúng user, gỡ các miền đã lưu trong tiến trình, xóa và xác minh toàn bộ Worker của user, rồi mới xóa dữ liệu riêng. Không dùng force-delete. Nguồn Telegram dùng chung được giữ.

Đổi tên hiển thị không tự đổi URL; đổi miền có thể yêu cầu user đăng nhập lại vì cookie thuộc hostname cũ. Tắt tự gắn miền chỉ ảnh hưởng việc tạo web mới, không xóa miền của web đang có.

## Khi thao tác chưa hoàn tất

- Thiếu quyền, miền trùng hoặc Cloudflare lỗi: giữ bản ghi và trạng thái lỗi để sửa quyền rồi thử lại. Không tạo lại cùng user để tránh thêm Worker trùng.
- Miền thuộc Worker khác: không ghi đè hoặc xóa. Chọn subdomain khác.
- Tạo web thành công nhưng gắn miền lỗi: web vẫn có URL workers.dev, màn hình báo cảnh báo. Sửa quyền/miền rồi chọn **Gắn / thử lại miền** hoặc **Chỉnh sửa**.
- Tạo Worker/router dở dang: bản ghi trạng thái `error` giữ tên Worker và khóa. Dùng **Update User Web**, kiểm tra đủ router, rồi **Resume**. Hoặc xóa có xác minh.
- Web cũ nằm ở Cloudflare account khác: vẫn sửa/cập nhật bằng thông tin account cũ, nhưng không tự chuyển Worker sang account của zone mới. Hệ thống báo cần di chuyển trước khi gắn miền. Không tự xóa dữ liệu cũ.
- Các custom domain/route thêm thủ công ngoài Master chưa nằm trong sổ quản lý này. Kiểm tra riêng trước khi xóa web đó. Master chỉ tự quản lý các miền do tính năng này gắn hoặc tiếp nhận sau khi xác minh đúng Worker.

## Kiểm chứng

Bộ test dùng SQLite chạy schema và truy vấn thật, với Cloudflare/AI/Buffer mô phỏng. Có kiểm tra nâng cấp web cũ, bảo toàn khóa, tạo web mới, trùng miền, lỗi quyền, timeout, pause/resume, xóa dở dang, lỗi D1, chống truy cập chéo và khóa thao tác đồng thời. CI chạy thêm Wrangler dry-run, Master+D1 local và web/router được sinh. Gói Windows kiểm tra PowerShell 5.1, EXE self-test, giải nén ZIP và tạo SHA-256; chỉ phát hành sau khi CI pass.

Các test này không thay thế kiểm tra DNS/SSL và đăng nhập trên Cloudflare thật của bạn. Gói tải về chưa tự cập nhật Master đang chạy; thực hiện bước Deploy / Update ở trên.
