// Tab Đồng bộ trong popup: kết nối máy chủ, mở khoá, đồng bộ ngay, ngắt kết nối.
const root = document.querySelector("#tab-sync");
let lastResult = ""; // thông báo của lần "Đồng bộ ngay" vừa xong, hiện ở lần vẽ lại kế tiếp

function send(type, extra = {}) {
  return chrome.runtime.sendMessage({ type: "sync:" + type, ...extra }).then((res) => {
    if (!res?.ok) throw new Error(res?.error?.message || "Lỗi không xác định");
    return res.data;
  });
}

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

const field = (type, placeholder, autocomplete = "off") => el("input", { type, placeholder, autocomplete });

// Chạy một thao tác chậm (PBKDF2 mất vài trăm ms): khoá nút, hiện lỗi nếu có.
function guarded(btn, msg, label, fn) {
  return async () => {
    btn.disabled = true;
    btn.textContent = "Đang xử lý...";
    msg.textContent = "";
    try {
      await fn();
    } catch (e) {
      msg.textContent = e.message;
      msg.className = "err";
      btn.disabled = false;
      btn.textContent = label;
    }
  };
}

const ago = (t) => {
  if (!t) return "chưa lần nào";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "vừa xong";
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  return new Date(t).toLocaleString("vi-VN");
};

function disconnectLink(msg) {
  const b = el("button", { className: "link", textContent: "Ngắt kết nối" });
  b.onclick = async () => {
    if (!confirm("Ngắt kết nối đồng bộ? Dữ liệu trên máy này được giữ nguyên, dữ liệu trên máy chủ cũng không bị xoá.")) return;
    try { await send("disconnect"); await renderSync(); } catch (e) { msg.textContent = e.message; msg.className = "err"; }
  };
  return b;
}

export async function renderSync() {
  root.innerHTML = "";
  const box = el("div", { className: "sync" });
  root.append(box);
  const msg = el("p");
  const st = await send("status");

  // 1. Chưa kết nối
  if (!st.connected) {
    const url = field("url", "Địa chỉ máy chủ (https://...workers.dev)", "url");
    const btn = el("button", { className: "main", textContent: "Kết nối" });
    const go = guarded(btn, msg, "Kết nối", async () => {
      const info = await send("probe", { url: url.value });
      renderConnectStep(info);
    });
    btn.onclick = go;
    url.onkeydown = (e) => e.key === "Enter" && go();
    box.append(
      el("p", { textContent: "Đồng bộ danh sách tài khoản Facebook đã lưu giữa các máy qua máy chủ Cloudflare của bạn. Dữ liệu (kể cả phiên đăng nhập) được mã hoá ngay trên máy này trước khi gửi đi." }),
      url, btn, msg
    );
    url.focus();
    return;
  }

  // 2. Đã kết nối nhưng cần mật khẩu (mới mở trình duyệt hoặc phiên hết hạn)
  if (!st.unlocked) {
    const pw = field("password", "Mật khẩu chính của đồng bộ", "current-password");
    const btn = el("button", { className: "main", textContent: "Mở khoá đồng bộ" });
    const go = guarded(btn, msg, "Mở khoá đồng bộ", async () => {
      await send("unlock", { password: pw.value });
      await renderSync();
    });
    btn.onclick = go;
    pw.onkeydown = (e) => e.key === "Enter" && go();
    if (st.lastError) { msg.textContent = st.lastError; msg.className = "err"; }
    box.append(el("p", { textContent: `Máy chủ: ${st.url}` }), pw, btn, msg, disconnectLink(msg));
    pw.focus();
    return;
  }

  // 3. Đang hoạt động
  const btn = el("button", { className: "main", textContent: "Đồng bộ ngay" });
  btn.onclick = guarded(btn, msg, "Đồng bộ ngay", async () => {
    const r = await send("now");
    lastResult = `Đã đồng bộ: gửi ${r.pushed}, nhận ${r.pulled} mục.`;
    await renderSync();
  });
  box.append(
    el("p", { textContent: `Đã kết nối: ${new URL(st.url).host}` }),
    el("p", { textContent: `Lần đồng bộ gần nhất: ${ago(st.lastSync)}` }),
    btn,
    el("p", { textContent: lastResult }),
    msg
  );
  lastResult = "";
  if (st.lastError) { msg.textContent = st.lastError; msg.className = "err"; }
  box.append(disconnectLink(msg));

}

// Bước 2 của kết nối: máy chủ đã có tài khoản (nhập mật khẩu) hoặc chưa (tạo mới).
function renderConnectStep(info) {
  root.innerHTML = "";
  const box = el("div", { className: "sync" });
  root.append(box);
  const msg = el("p");
  const pw = field("password", info.registered ? "Mật khẩu chính" : "Mật khẩu chính (tối thiểu 8 ký tự)", info.registered ? "current-password" : "new-password");
  const finish = async (extra) => {
    await send("connect", { url: info.url, password: pw.value, ...extra });
    await renderSync();
  };

  if (info.registered) {
    const btn = el("button", { className: "main", textContent: "Đăng nhập đồng bộ" });
    const go = guarded(btn, msg, "Đăng nhập đồng bộ", () => finish({}));
    btn.onclick = go;
    pw.onkeydown = (e) => e.key === "Enter" && go();
    box.append(el("p", { textContent: "Máy chủ đã có tài khoản đồng bộ. Nhập mật khẩu chính đã đặt trước đó." }), pw, btn, msg);
  } else {
    const code = field("text", "Mã thiết lập (trong setup-info.txt)");
    const pw2 = field("password", "Nhập lại mật khẩu chính", "new-password");
    const btn = el("button", { className: "main", textContent: "Tạo tài khoản đồng bộ" });
    btn.onclick = guarded(btn, msg, "Tạo tài khoản đồng bộ", async () => {
      if (pw.value !== pw2.value) throw new Error("Hai mật khẩu không khớp.");
      await finish({ setupCode: code.value });
    });
    box.append(
      el("p", { textContent: "Tạo tài khoản đồng bộ lần đầu. Hãy ghi nhớ mật khẩu chính: quên là không khôi phục được dữ liệu đã đồng bộ." }),
      code, pw, pw2, btn, msg
    );
  }
  const back = el("button", { className: "link", textContent: "Quay lại" });
  back.onclick = () => renderSync();
  box.append(back);
  pw.focus();
}

document.querySelector('#tabs button[data-tab="sync"]').addEventListener("click", () => renderSync());
