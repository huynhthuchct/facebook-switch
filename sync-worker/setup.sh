#!/bin/sh
# Cài đặt máy chủ đồng bộ FB Account Switcher lên Cloudflare (miễn phí).
# Cách dùng:  sh setup.sh        (macOS / Linux / WSL)
# Chạy lại nhiều lần cũng an toàn: dùng để cập nhật khi có phiên bản mới.
# Chỉ dùng cú pháp POSIX sh, không cần bash.

DB_NAME="fb-switcher-sync"
ROOT=$(cd "$(dirname "$0")" && pwd) || exit 1
TOTAL=6
TMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t qa-setup) || exit 1
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

# --- Màu (chỉ khi chạy trên terminal) ---
if [ -t 1 ]; then
  C_RED=$(printf '\033[31m'); C_GREEN=$(printf '\033[32m'); C_YELLOW=$(printf '\033[33m')
  C_CYAN=$(printf '\033[36m'); C_GRAY=$(printf '\033[90m'); C_OFF=$(printf '\033[0m')
else
  C_RED=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""; C_GRAY=""; C_OFF=""
fi

say()  { printf '%s%s%s\n' "$2" "$1" "$C_OFF"; }
step() { printf '\n%s[%s/%s] %s%s\n' "$C_CYAN" "$1" "$TOTAL" "$2" "$C_OFF"; }

stop_setup() {
  say "" ""
  say "CÓ LỖI: $1" "$C_RED"
  [ -n "$2" ] && say "$2" "$C_YELLOW"
  say "" ""
  say "Chụp màn hình cửa sổ này nếu cần nhờ người khác hỗ trợ." "$C_GRAY"
  exit 1
}

open_url() {
  if command -v open >/dev/null 2>&1; then open "$1" >/dev/null 2>&1
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1
  fi
  return 0
}

copy_clipboard() {
  if command -v pbcopy >/dev/null 2>&1; then printf '%s' "$1" | pbcopy
  elif command -v wl-copy >/dev/null 2>&1; then printf '%s' "$1" | wl-copy
  elif command -v xclip >/dev/null 2>&1; then printf '%s' "$1" | xclip -selection clipboard
  else return 1
  fi
}

# Chạy wrangler, lưu kết quả vào $TMP_DIR/out, mã thoát vào $WCODE.
# stdin rỗng để wrangler không hỏi lung tung (vd: tự thêm cấu hình trùng).
wr() {
  npx --yes wrangler@4 "$@" </dev/null >"$TMP_DIR/out" 2>&1
  WCODE=$?
  WOUT=$(cat "$TMP_DIR/out")
}

# Như wr nhưng vừa hiện ra màn hình vừa lưu lại.
wr_show() {
  { npx --yes wrangler@4 "$@" </dev/null 2>&1; echo $? >"$TMP_DIR/code"; } | tee "$TMP_DIR/out"
  WCODE=$(cat "$TMP_DIR/code")
  WOUT=$(cat "$TMP_DIR/out")
}

# Lấy id database từ `d1 list --json` (bỏ qua mọi dòng thừa trước/sau JSON).
get_database_id() {
  printf '%s' "$1" | node -e '
    const s = require("fs").readFileSync(0, "utf8");
    const a = s.indexOf("["), b = s.lastIndexOf("]");
    try {
      const hit = JSON.parse(s.slice(a, b + 1)).find((d) => d.name === process.argv[1]);
      if (hit) console.log(hit.uuid);
    } catch (e) {}
  ' "$2"
}

# Mã thiết lập: 16 ký tự, bỏ các ký tự dễ nhầm (0/O, 1/I/L).
new_setup_code() {
  node -e '
    const { randomInt } = require("crypto");
    const al = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let s = "";
    for (let i = 0; i < 16; i++) s += al[randomInt(al.length)];
    console.log(s.match(/.{4}/g).join("-"));
  '
}

# wrangler.toml được ghi lại hoàn toàn để không bao giờ bị trùng/lệch cấu hình.
write_wrangler_toml() {
  cat >"$ROOT/wrangler.toml" <<EOF
name = "$DB_NAME"
main = "src/index.js"
compatibility_date = "2025-01-01"

[[d1_databases]]
binding = "DB"
database_name = "$DB_NAME"
database_id = "$1"
EOF
}

main() {
  cd "$ROOT" || exit 1

  say "=============================================" "$C_GREEN"
  say "  Cài đặt máy chủ đồng bộ FB Account Switcher" "$C_GREEN"
  say "=============================================" "$C_GREEN"
  say "Bạn chỉ cần làm theo hướng dẫn trên màn hình. Mất khoảng 3-5 phút." ""

  # --- 1. Node.js ---
  step 1 "Kiểm tra Node.js"
  if ! command -v node >/dev/null 2>&1 || ! command -v npx >/dev/null 2>&1; then
    open_url "https://nodejs.org/en/download"
    stop_setup "Máy chưa cài Node.js." "Tải bản LTS tại https://nodejs.org/en/download, cài đặt rồi chạy lại: sh setup.sh"
  fi
  NODE_VER=$(node -v | sed 's/^v//')
  NODE_MAJOR=${NODE_VER%%.*}
  if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
    open_url "https://nodejs.org/en/download"
    stop_setup "Node.js quá cũ (đang là $NODE_VER, cần 18 trở lên)." "Tải bản LTS mới tại https://nodejs.org/en/download rồi chạy lại: sh setup.sh"
  fi
  say "OK: Node.js $NODE_VER" "$C_GREEN"

  # --- 2. Đăng nhập Cloudflare ---
  step 2 "Đăng nhập Cloudflare"
  wr whoami
  if ! printf '%s' "$WOUT" | grep -qi "logged in"; then
    say "Trình duyệt sẽ mở ra. Hãy đăng nhập (hoặc tạo tài khoản miễn phí) rồi bấm 'Allow' / 'Cho phép'." "$C_YELLOW"
    # Chạy trực tiếp (giữ stdin/tty) để wrangler hiện link đăng nhập nếu trình duyệt không tự mở.
    npx --yes wrangler@4 login || stop_setup "Đăng nhập Cloudflare không thành công." "Chạy lại: sh setup.sh rồi bấm Allow trong trình duyệt."
  fi
  say "OK: đã đăng nhập Cloudflare" "$C_GREEN"

  # --- 3. Tạo database ---
  step 3 "Tạo nơi lưu dữ liệu (D1)"
  wr d1 list --json
  DB_ID=$(get_database_id "$WOUT" "$DB_NAME")
  if [ -z "$DB_ID" ]; then
    wr d1 create "$DB_NAME"
    wr d1 list --json
    DB_ID=$(get_database_id "$WOUT" "$DB_NAME")
  fi
  [ -n "$DB_ID" ] || stop_setup "Không tạo được database." "Kiểm tra bạn đã xác minh email Cloudflare chưa, rồi chạy lại: sh setup.sh"
  write_wrangler_toml "$DB_ID"
  wr d1 execute "$DB_NAME" --remote --file=schema.sql --yes
  [ "$WCODE" -eq 0 ] || stop_setup "Không tạo được bảng dữ liệu." "$WOUT"
  say "OK: database sẵn sàng" "$C_GREEN"

  # --- 4. Đưa máy chủ lên mạng ---
  step 4 "Đưa máy chủ lên Cloudflare"
  wr_show deploy
  if [ "$WCODE" -ne 0 ]; then
    if printf '%s' "$WOUT" | grep -qi "subdomain"; then
      open_url "https://dash.cloudflare.com/?to=/:account/workers/onboarding"
      stop_setup "Tài khoản Cloudflare chưa có tên miền workers.dev." "Trang vừa mở: đặt một tên bất kỳ (vd: ten-cua-ban) rồi bấm Continue. Xong chạy lại: sh setup.sh"
    fi
    stop_setup "Đưa máy chủ lên không thành công." "Xem thông báo lỗi phía trên."
  fi
  URL=$(printf '%s' "$WOUT" | grep -Eo 'https://[A-Za-z0-9.-]+\.workers\.dev' | head -n 1)
  [ -n "$URL" ] || stop_setup "Không đọc được địa chỉ máy chủ." "Tìm dòng có chữ 'workers.dev' ở phía trên và ghi lại địa chỉ đó."
  say "OK: $URL" "$C_GREEN"

  # --- 5. Mã thiết lập ---
  step 5 "Tạo mã thiết lập"
  REGISTERED=0
  if command -v curl >/dev/null 2>&1; then
    sleep 3
    STATUS=$(curl -fsS --max-time 20 "$URL/api/status" 2>/dev/null)
    if printf '%s' "$STATUS" | grep -Eq '"registered"[[:space:]]*:[[:space:]]*true'; then
      REGISTERED=1
    fi
  fi

  CODE=""
  if [ "$REGISTERED" -eq 1 ]; then
    say "Máy chủ đã có tài khoản đồng bộ. Không cần tạo mã mới." "$C_GREEN"
  else
    CODE=$(new_setup_code)
    [ -n "$CODE" ] || stop_setup "Không tạo được mã thiết lập." ""
    printf '%s' "$CODE" | npx --yes wrangler@4 secret put SETUP_CODE >"$TMP_DIR/out" 2>&1
    PUT_CODE=$?
    [ "$PUT_CODE" -eq 0 ] || stop_setup "Không lưu được mã thiết lập." "$(cat "$TMP_DIR/out")"
    say "OK: đã tạo mã thiết lập" "$C_GREEN"
  fi

  # --- 6. Ghi thông tin ---
  step 6 "Hoàn tất"
  INFO="$ROOT/setup-info.txt"
  umask 077
  {
    echo "FB ACCOUNT SWITCHER - THÔNG TIN ĐỒNG BỘ"
    echo ""
    echo "Địa chỉ máy chủ : $URL"
    if [ -n "$CODE" ]; then
      echo "Mã thiết lập    : $CODE"
      echo ""
      echo "Mã thiết lập chỉ dùng MỘT LẦN, khi tạo tài khoản đồng bộ đầu tiên."
    fi
    echo ""
    echo "Cách dùng:"
    echo "1. Mở extension > tab 'Đồng bộ'."
    echo "2. Dán địa chỉ máy chủ ở trên, bấm Kết nối."
    if [ -n "$CODE" ]; then
      echo "3. Nhập mã thiết lập và đặt MẬT KHẨU CHÍNH (quên là mất dữ liệu đã đồng bộ)."
    else
      echo "3. Nhập mật khẩu chính đã đặt trước đó."
    fi
    echo "4. Trên máy khác: cài extension, vào tab 'Đồng bộ', dán địa chỉ, nhập mật khẩu chính."
    echo ""
    echo "Không chia sẻ file này cho ai."
  } >"$INFO"

  COPIED=""
  copy_clipboard "$URL" && COPIED="   (đã copy vào clipboard)"

  say "" ""
  say "=============================================" "$C_GREEN"
  say "  XONG! Máy chủ đã chạy." "$C_GREEN"
  say "=============================================" "$C_GREEN"
  say "Địa chỉ máy chủ : $URL$COPIED" ""
  [ -n "$CODE" ] && say "Mã thiết lập    : $CODE" ""
  say "" ""
  say "Thông tin cũng được lưu trong file setup-info.txt cùng thư mục." "$C_GRAY"
  say "Giờ hãy mở extension > tab 'Đồng bộ' và làm theo." "$C_YELLOW"
}

main "$@"
