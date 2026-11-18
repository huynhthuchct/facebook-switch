// Ý tưởng: mỗi tài khoản = 1 bộ cookie facebook.com.
// Chuyển tài khoản = xoá cookie hiện tại ở trình duyệt (KHÔNG gọi logout lên server,
// nên phiên đăng nhập vẫn còn hiệu lực) rồi nạp lại bộ cookie đã lưu.

import * as sync from "./sync.js";

const FB_DOMAIN = "facebook.com";

async function getFbCookies() {
  return chrome.cookies.getAll({ domain: FB_DOMAIN });
}

function cookieUrl(c) {
  const host = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
  return `https://${host}${c.path}`;
}

async function clearFbCookies() {
  const cookies = await getFbCookies();
  await Promise.all(
    cookies.map((c) => chrome.cookies.remove({ url: cookieUrl(c), name: c.name, storeId: c.storeId }))
  );
}

async function restoreCookies(cookies) {
  for (const c of cookies) {
    const details = {
      url: cookieUrl(c),
      name: c.name,
      value: c.value,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      storeId: c.storeId
    };
    if (!c.hostOnly) details.domain = c.domain;
    if (!c.session && c.expirationDate) details.expirationDate = c.expirationDate;
    try {
      await chrome.cookies.set(details);
    } catch (e) {
      console.warn("Không set được cookie", c.name, e);
    }
  }
}

async function getAccounts() {
  const { accounts = [] } = await chrome.storage.local.get("accounts");
  return accounts;
}

async function setAccounts(accounts) {
  await chrome.storage.local.set({ accounts });
}

async function currentUserId() {
  const c = await chrome.cookies.get({ url: "https://www.facebook.com", name: "c_user" });
  return c ? c.value : null;
}

// Lưu tài khoản đang đăng nhập (ghi đè nếu đã có cùng ID)
async function saveCurrent(label) {
  const id = await currentUserId();
  if (!id) throw new Error("Chưa đăng nhập Facebook trên trình duyệt.");
  const cookies = await getFbCookies();
  const accounts = await getAccounts();
  const existing = accounts.find((a) => a.id === id);
  const entry = {
    id,
    label: label || existing?.label || `Tài khoản ${id}`,
    cookies,
    savedAt: Date.now()
  };
  const next = existing ? accounts.map((a) => (a.id === id ? entry : a)) : [...accounts, entry];
  await setAccounts(next);
  return entry;
}

async function reloadFbTabs(fallbackUrl = "https://www.facebook.com/") {
  const tabs = await chrome.tabs.query({ url: "https://*.facebook.com/*" });
  if (tabs.length) {
    await Promise.all(tabs.map((t) => chrome.tabs.reload(t.id)));
  } else {
    await chrome.tabs.create({ url: fallbackUrl });
  }
}

async function switchTo(id) {
  const accounts = await getAccounts();
  const target = accounts.find((a) => a.id === id);
  if (!target) throw new Error("Không tìm thấy tài khoản.");

  // Cập nhật lại cookie của tài khoản hiện tại trước khi rời đi (nếu đã lưu)
  const cur = await currentUserId();
  if (cur && cur !== id && accounts.some((a) => a.id === cur)) await saveCurrent();

  await clearFbCookies();
  await restoreCookies(target.cookies);
  await reloadFbTabs();
}

// Thêm tài khoản mới: lưu tài khoản hiện tại, xoá cookie cục bộ, mở trang đăng nhập
async function addNew() {
  if (await currentUserId()) await saveCurrent();
  await clearFbCookies();
  await reloadFbTabs("https://www.facebook.com/login");
}

async function removeAccount(id) {
  const accounts = await getAccounts();
  await setAccounts(accounts.filter((a) => a.id !== id));
}

async function renameAccount(id, label) {
  const accounts = await getAccounts();
  await setAccounts(accounts.map((a) => (a.id === id ? { ...a, label } : a)));
}

const handlers = {
  list: async () => ({
    accounts: (await getAccounts()).map(({ id, label, savedAt }) => ({ id, label, savedAt })),
    current: await currentUserId()
  }),
  save: ({ label }) => saveCurrent(label).then(({ id, label }) => ({ id, label })),
  switch: ({ id }) => switchTo(id),
  add: () => addNew(),
  remove: ({ id }) => removeAccount(id),
  rename: ({ id, label }) => renameAccount(id, label)
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const fn = handlers[msg.type];
  if (!fn) return;
  Promise.resolve(fn(msg))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});

// ---- Đồng bộ nền: sau mỗi thay đổi (gom 3 giây) và định kỳ 15 phút ----
let syncTimer;
const autoSync = () => sync.syncNow().catch(() => {}); // lỗi đã được lưu vào trạng thái đồng bộ
chrome.alarms.get("sync-periodic", (a) => {
  if (!a) chrome.alarms.create("sync-periodic", { delayInMinutes: 1, periodInMinutes: 15 });
});
chrome.alarms.onAlarm.addListener((a) => a.name === "sync-periodic" && autoSync());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.accounts) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(autoSync, 3000);
});

const syncHandlers = {
  status: () => sync.status(),
  probe: ({ url }) => sync.probe(url),
  connect: ({ url, password, setupCode }) => sync.connect({ url, password, setupCode }),
  unlock: ({ password }) => sync.unlock({ password }),
  now: () => sync.syncNow(),
  disconnect: () => sync.disconnect()
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.tab) return;
  if (!msg.type?.startsWith("sync:")) return;
  const fn = syncHandlers[msg.type.slice(5)];
  if (!fn) return;
  Promise.resolve()
    .then(() => fn(msg))
    .then((data) => sendResponse({ ok: true, data: data ?? null }))
    .catch((e) => sendResponse({ ok: false, error: { name: e.name || "Error", message: e.message } }));
  return true;
});
