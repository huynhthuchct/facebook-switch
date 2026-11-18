const $ = (s) => document.querySelector(s);

function send(type, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...extra }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      res?.ok ? resolve(res.data) : reject(new Error(res?.error || "Lỗi không xác định"));
    });
  });
}

function say(text, isErr = false) {
  const el = $("#msg");
  el.textContent = text;
  el.className = isErr ? "err" : "";
}

async function run(fn, okText) {
  document.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    await fn();
    if (okText) say(okText);
  } catch (e) {
    say(e.message, true);
  } finally {
    await render();
  }
}

async function render() {
  const { accounts, current } = await send("list");
  const list = $("#list");
  list.innerHTML = "";

  if (!accounts.length) {
    say("Chưa có tài khoản nào. Đăng nhập Facebook rồi bấm “Lưu tài khoản hiện tại”.");
  }

  for (const a of accounts) {
    const li = document.createElement("li");
    if (a.id === current) li.classList.add("current");

    const img = document.createElement("img");
    img.src = `https://graph.facebook.com/${encodeURIComponent(a.id)}/picture?type=square`;
    img.onerror = () => (img.style.visibility = "hidden");

    const info = document.createElement("div");
    info.className = "info";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = a.label;
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = a.id === current ? "Đang dùng" : `ID ${a.id}`;
    info.append(name, sub);

    const btnSwitch = document.createElement("button");
    btnSwitch.textContent = "Chuyển";
    btnSwitch.disabled = a.id === current;
    btnSwitch.onclick = () => run(() => send("switch", { id: a.id }), `Đã chuyển sang ${a.label}`);

    const btnRename = document.createElement("button");
    btnRename.className = "icon";
    btnRename.title = "Đổi tên";
    btnRename.textContent = "✎";
    btnRename.onclick = () => {
      const label = prompt("Tên mới:", a.label);
      if (label) run(() => send("rename", { id: a.id, label }));
    };

    const btnDel = document.createElement("button");
    btnDel.className = "icon";
    btnDel.title = "Xoá khỏi danh sách";
    btnDel.textContent = "✕";
    btnDel.onclick = () => {
      if (confirm(`Xoá "${a.label}" khỏi danh sách? (Không đăng xuất tài khoản)`))
        run(() => send("remove", { id: a.id }));
    };

    li.append(img, info, btnSwitch, btnRename, btnDel);
    list.append(li);
  }

  document.querySelectorAll(".actions button").forEach((b) => (b.disabled = false));
}

$("#save").onclick = () =>
  run(async () => {
    const r = await send("save", { label: $("#label").value.trim() });
    $("#label").value = "";
    say(`Đã lưu: ${r.label}`);
  });

$("#add").onclick = () =>
  run(() => send("add"), "Đăng nhập tài khoản mới ở tab Facebook, rồi mở lại popup và bấm Lưu.");

render().catch((e) => say(e.message, true));
