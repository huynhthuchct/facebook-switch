# Cài đặt đồng bộ FB Account Switcher (dành cho người không rành kỹ thuật)

Sau khi cài xong, danh sách tài khoản Facebook đã lưu (kèm phiên đăng nhập) sẽ tự đồng bộ giữa các máy.
Dữ liệu được **mã hoá ngay trên máy bạn** trước khi gửi đi. Máy chủ Cloudflare chỉ giữ dữ liệu đã mã hoá, nên ngay cả Cloudflare cũng không đọc được.

Toàn bộ chạy trên tài khoản Cloudflare **miễn phí** của bạn. Mức dùng cá nhân nằm rất xa giới hạn miễn phí.

---

## Bước 0 — Chuẩn bị (chỉ làm 1 lần)

1. **Tài khoản Cloudflare miễn phí:** đăng ký tại <https://dash.cloudflare.com/sign-up> và xác minh email.
2. **Node.js:** tải bản **LTS** tại <https://nodejs.org>, cài đặt, bấm *Next* đến hết.

## Bước 1 — Cài máy chủ (3–5 phút)

1. Mở thư mục `sync-worker`, **bấm đúp file `setup.bat`**.
2. Một cửa sổ đen hiện ra và làm việc tự động. Khi **trình duyệt mở ra**, đăng nhập Cloudflare rồi bấm **Allow** (Cho phép).
3. Chờ đến khi thấy chữ **XONG!**. Lúc đó:
   - Địa chỉ máy chủ được **copy sẵn vào clipboard**.
   - File `setup-info.txt` tự mở, ghi **địa chỉ máy chủ** và **mã thiết lập**.

> **macOS / Linux:** mở Terminal trong thư mục `sync-worker` rồi chạy `sh setup.sh` (thay cho `setup.bat`; các bước và kết quả giống hệt).

> Nếu thấy chữ đỏ **CÓ LỖI**, đọc dòng màu vàng bên dưới, nó nói bạn cần làm gì rồi chạy lại `setup.bat` (hoặc `sh setup.sh`). Chạy lại bao nhiêu lần cũng an toàn.

## Bước 2 — Kết nối extension

1. Bấm biểu tượng extension, chọn tab **Đồng bộ**.
2. Dán **địa chỉ máy chủ** (hoặc Ctrl+V vì đã copy sẵn), bấm **Kết nối**.
3. Nhập **mã thiết lập** từ file `setup-info.txt`.
4. Đặt **mật khẩu chính** (tối thiểu 8 ký tự), nhập lại lần nữa, bấm **Tạo tài khoản đồng bộ**.

Xong. Dữ liệu hiện có sẽ được tải lên ngay.

> ⚠ **Hãy ghi nhớ mật khẩu chính.** Vì dữ liệu được mã hoá bằng mật khẩu này nên **không ai khôi phục được nếu bạn quên**, kể cả Cloudflare hay người làm ra extension. Nên lưu mật khẩu vào nơi an toàn.

## Bước 3 — Thêm máy thứ hai

1. Cài extension trên máy mới.
2. Vào tab **Đồng bộ**, dán địa chỉ máy chủ, bấm **Kết nối**.
3. Nhập **mật khẩu chính** đã đặt ở Bước 2 (không cần mã thiết lập nữa).

---

## Sử dụng hằng ngày

- Extension **tự đồng bộ** sau mỗi lần bạn thêm/xoá/sửa và định kỳ 15 phút. Muốn đồng bộ ngay thì bấm **Đồng bộ ngay**.
- Mỗi lần **mở lại trình duyệt**, bạn cần vào tab **Đồng bộ** và nhập lại mật khẩu chính một lần.
- **Phiên đăng nhập Facebook (cookie) cũng được đồng bộ**, mã hoá giống mọi dữ liệu khác. Facebook có thể yêu cầu xác minh lại nếu cùng một phiên được dùng ở máy/địa chỉ IP khác.
- Hai máy cùng sửa một mục thì **bản sửa sau cùng được giữ lại**.

## Bảo mật

- Ai biết địa chỉ máy chủ cũng **không đọc được gì**: dữ liệu luôn được mã hoá, và mã thiết lập chỉ dùng được **một lần**.
- Nhập sai mật khẩu quá nhiều lần sẽ bị khoá 15 phút.
- File `setup-info.txt` chứa mã thiết lập, **đừng chia sẻ**, và có thể xoá sau khi tạo tài khoản xong.

## Gặp sự cố?

| Thông báo | Cách xử lý |
|---|---|
| *Máy chưa cài Node.js* | Cài Node.js bản LTS (Bước 0) rồi chạy lại `setup.bat`. |
| *Chưa có tên miền workers.dev* | Trang Cloudflare tự mở: đặt một tên bất kỳ, bấm Continue, rồi chạy lại `setup.bat`. |
| *Sai mã thiết lập* | Copy lại đúng mã trong `setup-info.txt` (viết hoa, có dấu gạch ngang). |
| *Sai mật khẩu chính* | Nhập lại đúng mật khẩu đã đặt lúc tạo tài khoản đồng bộ. |
| *Nhập sai quá nhiều lần* | Chờ 15 phút rồi thử lại. |
| *Không kết nối được tới máy chủ* | Kiểm tra mạng và địa chỉ (phải bắt đầu bằng `https://`). Mở thẳng địa chỉ đó trong trình duyệt, thấy chữ "Đã hoạt động" là máy chủ ổn. |
| *Phiên đăng nhập đã hết hạn* | Vào tab Đồng bộ và nhập lại mật khẩu chính. |
| *Không giải mã được dữ liệu trên máy chủ* | Mật khẩu chính trên máy này khác với lúc tạo tài khoản đồng bộ. Đăng xuất đồng bộ rồi đăng nhập lại bằng đúng mật khẩu. |

## Cập nhật / Gỡ bỏ

- **Cập nhật** khi có phiên bản mới: tải bản mới về, chạy lại `setup.bat`. Dữ liệu được giữ nguyên.
- **Gỡ hoàn toàn:** vào <https://dash.cloudflare.com> → *Workers & Pages* → chọn `fb-switcher-sync` → *Settings* → *Delete*. Sau đó vào *Storage & Databases → D1* xoá database `fb-switcher-sync`.

## Dành cho người rành kỹ thuật

- Máy chủ là một Cloudflare Worker (`src/index.js`) dùng D1 (`schema.sql`). Người dùng đơn: đăng ký bị khoá sau tài khoản đầu tiên, và cần `SETUP_CODE` (secret của Worker).
- Mật khẩu chính → PBKDF2-SHA256 (600.000 vòng) → HKDF thành 2 khoá độc lập: `authKey` (đăng nhập, server chỉ lưu SHA-256) và `encKey` (AES-GCM, không rời máy; id mục được gắn làm AAD).
- Đồng bộ theo từng mục, "bản mới nhất thắng", xoá bằng tombstone, ghi bằng khoá lạc quan (`baseRev`).
- Dữ liệu D1 có thể khôi phục về thời điểm trước đó bằng *Time Travel* (`wrangler d1 time-travel`).
- Chạy thử cục bộ: tạo `.dev.vars` với `SETUP_CODE=...`, rồi `npx wrangler d1 execute fb-switcher-sync --local --file=schema.sql` và `npx wrangler dev`.
