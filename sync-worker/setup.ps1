# Cài đặt máy chủ đồng bộ FB Account Switcher lên Cloudflare (miễn phí).
# Cách dùng: bấm đúp file setup.bat (không cần mở file này).
# Chạy lại nhiều lần cũng an toàn: dùng để cập nhật khi có phiên bản mới.

param([switch]$NoRun)

$ErrorActionPreference = "Continue"
$DbName = "fb-switcher-sync"
$Root = $PSScriptRoot

function Say($msg, $color = "White") { Write-Host $msg -ForegroundColor $color }
function Step($n, $total, $text) { Say "`n[$n/$total] $text" "Cyan" }

function Stop-Setup($msg, $hint) {
  Say "`nCÓ LỖI: $msg" "Red"
  if ($hint) { Say $hint "Yellow" }
  Say "`nChụp màn hình cửa sổ này nếu cần nhờ người khác hỗ trợ." "Gray"
  exit 1
}

# Chạy wrangler, trả về @{ Code; Text }. Hiện kết quả ra màn hình khi $Show.
function Invoke-Wrangler {
  param([string[]]$WArgs, [string]$InputText = $null, [switch]$Show)
  $lines = New-Object System.Collections.Generic.List[string]
  $emit = { param($l) $lines.Add([string]$l); if ($Show) { Write-Host $l } }
  if ($null -ne $InputText) {
    $InputText | & npx --yes wrangler@4 @WArgs 2>&1 | ForEach-Object { & $emit $_ }
  } else {
    # Truyền stdin rỗng để wrangler không hỏi lung tung (vd: tự thêm cấu hình trùng)
    "" | & npx --yes wrangler@4 @WArgs 2>&1 | ForEach-Object { & $emit $_ }
  }
  return @{ Code = $LASTEXITCODE; Text = ($lines -join "`n") }
}

# wrangler.toml được ghi lại hoàn toàn để không bao giờ bị trùng/lệch cấu hình.
function New-WranglerToml($databaseId) {
@"
name = "$DbName"
main = "src/index.js"
compatibility_date = "2025-01-01"

[[d1_databases]]
binding = "DB"
database_name = "$DbName"
database_id = "$databaseId"
"@
}

# Mã thiết lập: 16 ký tự, bỏ các ký tự dễ nhầm (0/O, 1/I/L).
function New-SetupCode {
  $alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789".ToCharArray()
  $bytes = New-Object byte[] 16
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $chars = foreach ($b in $bytes) { $alphabet[$b % $alphabet.Length] }
  $s = -join $chars
  return "$($s.Substring(0,4))-$($s.Substring(4,4))-$($s.Substring(8,4))-$($s.Substring(12,4))"
}

# Lấy id database từ kết quả `d1 list --json` (bỏ qua mọi dòng thừa trước/sau JSON).
function Get-DatabaseId($text, $name) {
  $start = $text.IndexOf("[")
  $end = $text.LastIndexOf("]")
  if ($start -lt 0 -or $end -le $start) { return $null }
  try { $list = $text.Substring($start, $end - $start + 1) | ConvertFrom-Json } catch { return $null }
  $hit = $list | Where-Object { $_.name -eq $name } | Select-Object -First 1
  if ($hit) { return $hit.uuid }
  return $null
}

function Get-WorkerUrl($text) {
  $m = [regex]::Match($text, "https://[A-Za-z0-9.-]+\.workers\.dev")
  if ($m.Success) { return $m.Value }
  return $null
}

function Main {
  Set-Location $Root
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $total = 6

  Say "=============================================" "Green"
  Say "  Cài đặt máy chủ đồng bộ FB Account Switcher" "Green"
  Say "=============================================" "Green"
  Say "Bạn chỉ cần làm theo hướng dẫn trên màn hình. Mất khoảng 3-5 phút."

  # --- 1. Node.js ---
  Step 1 $total "Kiểm tra Node.js"
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Start-Process "https://nodejs.org/en/download"
    Stop-Setup "Máy chưa cài Node.js." "Trang tải Node.js vừa được mở. Tải bản LTS, cài đặt (bấm Next đến hết), rồi bấm đúp setup.bat lần nữa."
  }
  $ver = (& node -v).TrimStart("v")
  if ([int]($ver.Split(".")[0]) -lt 18) {
    Start-Process "https://nodejs.org/en/download"
    Stop-Setup "Node.js quá cũ (đang là $ver, cần 18 trở lên)." "Tải bản LTS mới tại trang vừa mở, cài đặt rồi chạy lại setup.bat."
  }
  Say "OK: Node.js $ver" "Green"

  # --- 2. Đăng nhập Cloudflare ---
  Step 2 $total "Đăng nhập Cloudflare"
  $who = Invoke-Wrangler -WArgs @("whoami")
  if ($who.Text -notmatch "(?i)logged in") {
    Say "Trình duyệt sẽ mở ra. Hãy đăng nhập (hoặc tạo tài khoản miễn phí) rồi bấm 'Allow' / 'Cho phép'." "Yellow"
    $login = Invoke-Wrangler -WArgs @("login") -Show
    if ($login.Code -ne 0) { Stop-Setup "Đăng nhập Cloudflare không thành công." "Chạy lại setup.bat và bấm Allow trong trình duyệt." }
  }
  Say "OK: đã đăng nhập Cloudflare" "Green"

  # --- 3. Tạo database ---
  Step 3 $total "Tạo nơi lưu dữ liệu (D1)"
  $listArgs = @("d1", "list", "--json")
  $id = Get-DatabaseId (Invoke-Wrangler -WArgs $listArgs).Text $DbName
  if (-not $id) {
    $null = Invoke-Wrangler -WArgs @("d1", "create", $DbName)
    $id = Get-DatabaseId (Invoke-Wrangler -WArgs $listArgs).Text $DbName
  }
  if (-not $id) { Stop-Setup "Không tạo được database." "Kiểm tra bạn đã xác minh email Cloudflare chưa, rồi chạy lại setup.bat." }
  Set-Content -Path (Join-Path $Root "wrangler.toml") -Value (New-WranglerToml $id) -Encoding UTF8
  $schema = Invoke-Wrangler -WArgs @("d1", "execute", $DbName, "--remote", "--file=schema.sql", "--yes")
  if ($schema.Code -ne 0) { Stop-Setup "Không tạo được bảng dữ liệu." $schema.Text }
  Say "OK: database sẵn sàng" "Green"

  # --- 4. Đưa máy chủ lên mạng ---
  Step 4 $total "Đưa máy chủ lên Cloudflare"
  $deploy = Invoke-Wrangler -WArgs @("deploy") -Show
  if ($deploy.Code -ne 0) {
    if ($deploy.Text -match "(?i)subdomain") {
      Start-Process "https://dash.cloudflare.com/?to=/:account/workers/onboarding"
      Stop-Setup "Tài khoản Cloudflare chưa có tên miền workers.dev." "Trang vừa mở: đặt một tên bất kỳ (vd: ten-cua-ban) rồi bấm Continue. Xong chạy lại setup.bat."
    }
    Stop-Setup "Đưa máy chủ lên không thành công." "Xem thông báo lỗi phía trên."
  }
  $url = Get-WorkerUrl $deploy.Text
  if (-not $url) { Stop-Setup "Không đọc được địa chỉ máy chủ." "Tìm dòng có chữ 'workers.dev' ở phía trên và ghi lại địa chỉ đó." }
  Say "OK: $url" "Green"

  # --- 5. Mã thiết lập ---
  Step 5 $total "Tạo mã thiết lập"
  $registered = $false
  try {
    Start-Sleep -Seconds 3
    $status = Invoke-RestMethod -Uri "$url/api/status" -TimeoutSec 20
    $registered = [bool]$status.registered
  } catch { }

  $code = $null
  if ($registered) {
    Say "Máy chủ đã có tài khoản đồng bộ. Không cần tạo mã mới." "Green"
  } else {
    $code = New-SetupCode
    $put = Invoke-Wrangler -WArgs @("secret", "put", "SETUP_CODE") -InputText $code
    if ($put.Code -ne 0) { Stop-Setup "Không lưu được mã thiết lập." $put.Text }
    Say "OK: đã tạo mã thiết lập" "Green"
  }

  # --- 6. Ghi thông tin ---
  Step 6 $total "Hoàn tất"
  $info = @("FB ACCOUNT SWITCHER - THÔNG TIN ĐỒNG BỘ", "", "Địa chỉ máy chủ : $url")
  if ($code) {
    $info += "Mã thiết lập    : $code"
    $info += ""
    $info += "Mã thiết lập chỉ dùng MỘT LẦN, khi tạo tài khoản đồng bộ đầu tiên."
  }
  $info += ""
  $info += "Cách dùng:"
  $info += "1. Mở extension > tab 'Đồng bộ'."
  $info += "2. Dán địa chỉ máy chủ ở trên, bấm Kết nối."
  if ($code) {
    $info += "3. Nhập mã thiết lập và đặt MẬT KHẨU CHÍNH (quên là mất dữ liệu đã đồng bộ)."
  } else {
    $info += "3. Nhập mật khẩu chính đã đặt trước đó."
  }
  $info += "4. Trên máy khác: cài extension, vào tab 'Đồng bộ', dán địa chỉ, nhập mật khẩu chính."
  $info += ""
  $info += "Không chia sẻ file này cho ai."
  Set-Content -Path (Join-Path $Root "setup-info.txt") -Value $info -Encoding UTF8

  try { Set-Clipboard -Value $url } catch { }

  Say "`n=============================================" "Green"
  Say "  XONG! Máy chủ đã chạy." "Green"
  Say "=============================================" "Green"
  Say "Địa chỉ máy chủ : $url   (đã copy vào clipboard)" "White"
  if ($code) { Say "Mã thiết lập    : $code" "White" }
  Say "`nThông tin cũng được lưu trong file setup-info.txt cùng thư mục." "Gray"
  Say "Giờ hãy mở extension > tab 'Đồng bộ' và làm theo." "Yellow"
  Start-Process notepad.exe (Join-Path $Root "setup-info.txt")
}

if (-not $NoRun) { Main }
