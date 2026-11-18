// Đồng bộ nền với FB Account Switcher Sync (Cloudflare Worker).
//
// Mật khẩu chính --PBKDF2-SHA256--> HKDF --> authKey (đăng nhập) + encKey (AES-GCM).
// Server chỉ thấy authKey và dữ liệu đã mã hoá. encKey nằm trong chrome.storage.session
// (RAM) nên mỗi lần mở lại trình duyệt phải nhập lại mật khẩu chính.
//
// Mỗi tài khoản Facebook đã lưu là một bản ghi riêng: id "fb:<id>".
// Bản ghi mã hoá {t, deleted?, data}; "bản sửa sau cùng thắng" theo t, xoá bằng tombstone.
import { b64uEnc, b64uDec } from "./b64.js";

const ITER = 600000;
const KEY = "syncKey";
const MAX_ATTEMPTS = 3;
const te = new TextEncoder();
const td = new TextDecoder();

const fail = (message, name = "Error") => Object.assign(new Error(message), { name });

// ---- Tuần tự hoá: không bao giờ có hai lần đồng bộ/đổi trạng thái chạy chồng nhau ----
let chain = Promise.resolve();
let running = false;
const serial = (fn) => {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
};

// ---- Trạng thái ----
const getState = async () => (await chrome.storage.local.get("sync")).sync || null;
const setState = (sync) => chrome.storage.local.set({ sync });

async function sessionKey() {
  const k = (await chrome.storage.session.get(KEY))[KEY];
  return k ? b64uDec(k) : null;
}
const setSessionKey = (raw) => chrome.storage.session.set({ [KEY]: b64uEnc(raw) });
const clearSessionKey = () => chrome.storage.session.remove(KEY);

// ---- Mật mã ----
async function deriveKeys(password, saltB64) {
  const base = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveBits"]);
  const master = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: b64uDec(saltB64), iterations: ITER }, base, 256
    )
  );
  const hk = await crypto.subtle.importKey("raw", master, "HKDF", false, ["deriveBits"]);
  const sub = async (info) =>
    new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: te.encode(info) }, hk, 256
      )
    );
  return { authKey: b64uEnc(await sub("qa-sync-auth")), encKey: await sub("qa-sync-enc") };
}

const aesKey = (raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);

// id mục được gắn làm AAD: server không thể hoán đổi bản ghi giữa các mục.
async function encryptItem(key, id, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: te.encode(id) }, key, te.encode(JSON.stringify(payload))
    )
  );
  return { iv: b64uEnc(iv), ct: b64uEnc(ct) };
}

async function decryptItem(key, id, item) {
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64uDec(item.iv), additionalData: te.encode(id) }, key, b64uDec(item.ct)
    );
    return JSON.parse(td.decode(pt));
  } catch {
    throw fail(
      "Không giải mã được dữ liệu trên máy chủ. Mật khẩu chính trên máy này khác với lúc tạo tài khoản đồng bộ.",
      "Decrypt"
    );
  }
}

// Băm nội dung theo thứ tự khoá cố định, để biết một mục đã đổi hay chưa.
const stable = (v) =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x
  );
async function hashOf(v) {
  return b64uEnc(new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(stable(v)))));
}

// ---- Gọi API ----
const API_ERRORS = {
  bad_credentials: "Sai mật khẩu chính.",
  bad_setup_code: "Sai mã thiết lập.",
  too_many_attempts: "Nhập sai quá nhiều lần. Chờ 15 phút rồi thử lại.",
  already_registered: "Máy chủ đã có tài khoản đồng bộ. Hãy đăng nhập bằng mật khẩu chính.",
  setup_code_missing: "Máy chủ chưa có mã thiết lập. Chạy lại setup.sh (hoặc setup.bat) trong thư mục sync-worker.",
  too_large: "Dữ liệu quá lớn để đồng bộ."
};

async function api(url, path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(url + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store"
    });
  } catch {
    throw fail("Không kết nối được tới máy chủ. Kiểm tra mạng và địa chỉ.", "Network");
  }
  let data = null;
  try { data = await res.json(); } catch { /* không phải JSON */ }
  if (res.ok) return data;
  const code = data?.error;
  if (res.status === 401 && code === "unauthorized")
    throw fail("Phiên đăng nhập đã hết hạn. Nhập lại mật khẩu chính.", "Unauthorized");
  if (res.status === 409 && code === "conflict") throw Object.assign(fail("conflict", "Conflict"), { rev: data.rev });
  throw fail(API_ERRORS[code] || `Máy chủ báo lỗi (${res.status}).`, "Api");
}

function normalizeUrl(input) {
  let u;
  try { u = new URL(String(input || "").trim()); } catch { throw fail("Địa chỉ máy chủ không hợp lệ."); }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:"))
    throw fail("Địa chỉ máy chủ phải bắt đầu bằng https://");
  return u.origin;
}

// ---- Dữ liệu cục bộ ----
async function snapshot() {
  const map = new Map();
  const { accounts = [] } = await chrome.storage.local.get("accounts");
  for (const a of accounts) map.set(`fb:${a.id}`, a);
  return map;
}

// Ghi dữ liệu kéo về. Mục nào vừa bị sửa tại chỗ (khác bản chụp) thì bỏ qua, lần sau xử lý lại.
async function applyPulls({ upserts, deletes }, snapHash) {
  const skipped = new Set();
  if (!upserts.length && !deletes.length) return skipped;
  const { accounts = [] } = await chrome.storage.local.get("accounts");
  const byId = new Map(accounts.map((a) => [`fb:${a.id}`, a]));
  const untouched = async (id) => {
    const cur = byId.get(id);
    return (cur ? await hashOf(cur) : null) === (snapHash.get(id) ?? null);
  };
  for (const [id, data] of upserts) {
    if (await untouched(id)) byId.set(id, data); else skipped.add(id);
  }
  for (const id of deletes) {
    if (await untouched(id)) byId.delete(id); else skipped.add(id);
  }
  await chrome.storage.local.set({ accounts: [...byId.values()] });
  return skipped;
}

// Một vòng đồng bộ. Trả về { pushed, pulled, retry }.
async function syncOnce(state, encRaw) {
  const key = await aesKey(encRaw);
  const { items } = await api(state.url, "/api/items", { token: state.token });

  const remote = new Map();
  for (const it of items) {
    const payload = await decryptItem(key, it.id, it);
    remote.set(it.id, { rev: it.rev, t: payload.t, deleted: !!payload.deleted, data: payload.data });
  }

  const local = await snapshot();
  const meta = state.meta;
  const now = Date.now();

  const ids = new Set([...local.keys(), ...remote.keys(), ...Object.keys(meta)]);
  const upserts = [];   // [id, data, newMeta] kéo về
  const deletes = [];   // id xoá cục bộ
  const pushes = [];    // { id, payload, baseRev, newMeta }
  const adopt = {};     // id -> meta mới, không cần làm gì thêm
  const snapHash = new Map();

  for (const id of ids) {
    const m = meta[id];
    const r = remote.get(id);
    const lv = local.get(id);
    const lh = lv === undefined ? null : await hashOf(lv);
    snapHash.set(id, lh);

    if (lv !== undefined) {
      const lt = m && m.h === lh ? m.t : now;
      if (!r) {
        pushes.push({ id, baseRev: 0, payload: { t: lt, data: lv }, meta: { h: lh, t: lt } });
      } else if (r.deleted) {
        if (lt > r.t) pushes.push({ id, baseRev: r.rev, payload: { t: lt, data: lv }, meta: { h: lh, t: lt } });
        else { deletes.push(id); adopt[id] = { h: null, t: r.t, rev: r.rev }; }
      } else {
        const rh = await hashOf(r.data);
        if (rh === lh) adopt[id] = { h: lh, t: r.t, rev: r.rev };
        else if (lt > r.t) pushes.push({ id, baseRev: r.rev, payload: { t: lt, data: lv }, meta: { h: lh, t: lt } });
        else { upserts.push([id, r.data]); adopt[id] = { h: rh, t: r.t, rev: r.rev }; }
      }
    } else if (m && m.h !== null) {
      // Đã đồng bộ trước đây nhưng giờ không còn ở máy này: người dùng vừa xoá.
      if (!r) delete meta[id];
      else if (r.deleted) adopt[id] = { h: null, t: r.t, rev: r.rev };
      else pushes.push({ id, baseRev: r.rev, payload: { t: now, deleted: true }, meta: { h: null, t: now } });
    } else if (r) {
      if (r.deleted) {
        if (!m || m.rev !== r.rev || m.t !== r.t) adopt[id] = { h: null, t: r.t, rev: r.rev };
      } else if (m && m.t >= r.t) {
        pushes.push({ id, baseRev: r.rev, payload: { t: m.t, deleted: true }, meta: { h: null, t: m.t } });
      } else {
        upserts.push([id, r.data]); adopt[id] = { h: await hashOf(r.data), t: r.t, rev: r.rev };
      }
    }
  }

  let retry = false;
  let pushed = 0;
  for (const p of pushes) {
    const enc = await encryptItem(key, p.id, p.payload);
    try {
      const res = await api(state.url, `/api/items/${encodeURIComponent(p.id)}`, {
        method: "PUT", token: state.token, body: { baseRev: p.baseRev, ...enc }
      });
      meta[p.id] = { ...p.meta, rev: res.rev };
      pushed++;
    } catch (e) {
      if (e.name !== "Conflict") throw e;
      retry = true; // máy khác vừa ghi: lấy lại danh sách rồi tính lại
    }
  }

  const skipped = await applyPulls({ upserts, deletes }, snapHash);
  for (const [id, mm] of Object.entries(adopt)) if (!skipped.has(id)) meta[id] = mm;
  if (skipped.size) retry = true;

  return { pushed, pulled: upserts.length + deletes.length - skipped.size, retry };
}

// ---- API công khai ----
export async function probe(urlInput) {
  const url = normalizeUrl(urlInput);
  const st = await api(url, "/api/status");
  return { url, registered: !!st.registered };
}

// Đăng nhập đã xong; lỗi đồng bộ (nếu có) đã được lưu vào lastError và hiện ở tab Đồng bộ.
const syncAfterLogin = () => syncNow().catch(() => null);

export function connect({ url: urlInput, password, setupCode }) {
  return serial(async () => {
    const url = normalizeUrl(urlInput);
    if (!password || password.length < 8) throw fail("Mật khẩu chính tối thiểu 8 ký tự.");
    const st = await api(url, "/api/status");
    let salt = st.salt;
    let keys;
    if (!st.registered) {
      if (!setupCode?.trim()) throw fail("Nhập mã thiết lập (xem file setup-info.txt).");
      salt = b64uEnc(crypto.getRandomValues(new Uint8Array(16)));
      keys = await deriveKeys(password, salt);
      await api(url, "/api/register", { method: "POST", body: { setupCode: setupCode.trim(), salt, authKey: keys.authKey } });
    } else {
      keys = await deriveKeys(password, salt);
    }
    const { token } = await api(url, "/api/login", { method: "POST", body: { authKey: keys.authKey } });
    await setState({ url, salt, token, meta: {}, lastSync: 0, lastError: null });
    await setSessionKey(keys.encKey);
  }).then(syncAfterLogin);
}

export function unlock({ password }) {
  return serial(async () => {
    const state = await getState();
    if (!state) throw fail("Chưa kết nối máy chủ đồng bộ.");
    const keys = await deriveKeys(password || "", state.salt);
    const { token } = await api(state.url, "/api/login", { method: "POST", body: { authKey: keys.authKey } });
    await setState({ ...state, token, lastError: null });
    await setSessionKey(keys.encKey);
  }).then(syncAfterLogin);
}

export function disconnect() {
  return serial(async () => {
    const state = await getState();
    if (state?.token) {
      try { await api(state.url, "/api/logout", { method: "POST", token: state.token }); } catch { /* bỏ qua */ }
    }
    await chrome.storage.local.remove("sync");
    await clearSessionKey();
  });
}

export async function status() {
  const state = await getState();
  return {
    connected: !!state,
    unlocked: !!state && !!(await sessionKey()),
    url: state?.url || null,
    lastSync: state?.lastSync || 0,
    lastError: state?.lastError || null,
    syncing: running
  };
}

export function syncNow() {
  return serial(async () => {
    const state = await getState();
    if (!state) throw fail("Chưa kết nối máy chủ đồng bộ.", "NotConnected");
    const encRaw = await sessionKey();
    if (!encRaw) throw fail("Cần nhập mật khẩu chính để đồng bộ.", "Locked");

    running = true;
    let total = { pushed: 0, pulled: 0 };
    try {
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const r = await syncOnce(state, encRaw);
        total = { pushed: total.pushed + r.pushed, pulled: total.pulled + r.pulled };
        if (!r.retry) break;
      }
      state.lastSync = Date.now();
      state.lastError = null;
      await setState(state);
      return total;
    } catch (e) {
      if (e.name === "Unauthorized") await clearSessionKey();
      state.lastError = e.message;
      await setState(state);
      throw e;
    } finally {
      running = false;
    }
  });
}
