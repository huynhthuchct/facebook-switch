// FB Account Switcher Sync: API một người dùng, lưu dữ liệu ĐÃ MÃ HOÁ trong D1.
// Server không bao giờ có khoá giải mã. Mật khẩu chính không rời khỏi extension.

const SESSION_DAYS = 30;
const MAX_SESSIONS = 10;
const MAX_BODY = 100_000;
const ID_RE = /^fb:[A-Za-z0-9_-]{1,100}$/;
const B64U_RE = /^[A-Za-z0-9_-]+$/;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400"
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS }
  });

const te = new TextEncoder();

function b64uEnc(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64uDec(str) {
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256b64u(bytes) {
  return b64uEnc(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

// So sánh chuỗi thời gian không đổi (băm trước để độ dài không lộ ra).
async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256b64u(te.encode(a)), sha256b64u(te.encode(b))]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

async function readJson(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw Object.assign(new Error("too_large"), { status: 413 });
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("bad_json"), { status: 400 });
  }
}

const getMeta = async (env, key) =>
  (await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first())?.value ?? null;

const validKeys = (salt, key) =>
  typeof salt === "string" && B64U_RE.test(salt) && salt.length >= 16 && salt.length <= 64 &&
  typeof key === "string" && B64U_RE.test(key) && key.length === 43;

// ---- Xác thực phiên ----
async function authed(req, env) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.get("authorization") || "");
  if (!m) return false;
  const hash = await sha256b64u(te.encode(m[1]));
  const row = await env.DB.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").bind(hash).first();
  return !!row && row.expires_at > Date.now();
}

const HOME = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>FB Account Switcher Sync</title>
<body style="font:16px system-ui;max-width:32em;margin:15vh auto;padding:0 1em;text-align:center">
<h1>✅ Đã hoạt động</h1>
<p>Máy chủ đồng bộ FB Account Switcher đang chạy.<br>Quay lại extension, dán địa chỉ trang này vào tab <b>Đồng bộ</b>.</p></body>`;

async function route(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (req.method === "GET" && path === "/")
    return new Response(HOME, { headers: { "content-type": "text/html; charset=utf-8" } });

  if (req.method === "GET" && path === "/api/status") {
    const salt = await getMeta(env, "salt");
    const wrapped = await getMeta(env, "wrapped_key");
    return json({ registered: !!salt, salt: salt || null, wrappedKey: wrapped ? JSON.parse(wrapped) : null });
  }

  // Đặt lại bằng mã thiết lập: thay tài khoản và bỏ ciphertext dùng khoá cũ.
  if (req.method === "POST" && path === "/api/password/reset") {
    if (!env.SETUP_CODE) return json({ error: "setup_code_missing" }, 503);
    const body = await readJson(req);
    if (typeof body.setupCode !== "string" || !(await safeEqual(body.setupCode, env.SETUP_CODE))) {
      return json({ error: "bad_setup_code" }, 403);
    }
    if (body.confirmReset !== true || !validKeys(body.salt, body.authKey))
      return json({ error: "bad_request" }, 400);
    const hash = await sha256b64u(b64uDec(body.authKey));
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions"),
      env.DB.prepare("DELETE FROM items"),
      env.DB.prepare("DELETE FROM meta"),
      env.DB.prepare("INSERT INTO meta (key, value) VALUES ('salt', ?)").bind(body.salt),
      env.DB.prepare("INSERT INTO meta (key, value) VALUES ('auth_hash', ?)").bind(hash)
    ]);
    return json({ ok: true });
  }

  // Đổi mật khẩu: chỉ bọc lại khoá dữ liệu, không thay ciphertext của các mục.
  if (req.method === "POST" && path === "/api/password/change") {
    const body = await readJson(req);
    const stored = await getMeta(env, "auth_hash");
    if (!stored || !validKeys(body.salt, body.authKey) ||
        !(await safeEqual(await sha256b64u(b64uDec(body.authKey)), stored))) {
      return json({ error: "bad_credentials" }, 401);
    }
    const wrapped = body.wrappedKey;
    if (!validKeys(body.salt, body.newAuthKey) || !wrapped ||
        typeof wrapped.iv !== "string" || !B64U_RE.test(wrapped.iv) || wrapped.iv.length !== 16 ||
        typeof wrapped.ct !== "string" || !B64U_RE.test(wrapped.ct) || wrapped.ct.length < 64 || wrapped.ct.length > 256)
      return json({ error: "bad_request" }, 400);
    const hash = await sha256b64u(b64uDec(body.newAuthKey));
    // Mọi câu lệnh cùng guard và cùng transaction D1: tránh hai lần đổi/reset ghi chéo.
    const guard = "EXISTS (SELECT 1 FROM meta WHERE key = 'auth_hash' AND value = ?)";
    const results = await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE " + guard).bind(stored),
      env.DB.prepare("UPDATE meta SET value = ? WHERE key = 'salt' AND " + guard).bind(body.salt, stored),
      env.DB.prepare("INSERT INTO meta (key, value) SELECT 'wrapped_key', ? WHERE " + guard +
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(wrapped), stored),
      env.DB.prepare("UPDATE meta SET value = ? WHERE key = 'auth_hash' AND value = ?").bind(hash, stored)
    ]);
    if (results[3].meta.changes !== 1) return json({ error: "account_changed" }, 409);
    return json({ ok: true });
  }

  if (req.method === "POST" && path === "/api/register") {
    const body = await readJson(req);
    if (!env.SETUP_CODE) return json({ error: "setup_code_missing" }, 503);
    if (await getMeta(env, "salt")) return json({ error: "already_registered" }, 409);

    const okCode = typeof body.setupCode === "string" && (await safeEqual(body.setupCode, env.SETUP_CODE));
    if (!okCode) {
      return json({ error: "bad_setup_code" }, 403);
    }
    const { salt, authKey } = body;
    if (typeof salt !== "string" || !B64U_RE.test(salt) || salt.length < 16 || salt.length > 64 ||
        typeof authKey !== "string" || !B64U_RE.test(authKey) || authKey.length !== 43)
      return json({ error: "bad_request" }, 400);

    const authHash = await sha256b64u(b64uDec(authKey));
    const res = await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('salt', ?)").bind(salt),
      env.DB.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('auth_hash', ?)").bind(authHash)
    ]);
    if (res[0].meta.changes !== 1) return json({ error: "already_registered" }, 409);
    return json({ ok: true });
  }

  if (req.method === "POST" && path === "/api/login") {
    const body = await readJson(req);
    const stored = await getMeta(env, "auth_hash");
    let ok = false;
    if (stored && typeof body.authKey === "string" && B64U_RE.test(body.authKey) && body.authKey.length === 43)
      ok = await safeEqual(await sha256b64u(b64uDec(body.authKey)), stored);
    if (!ok) {
      return json({ error: "bad_credentials" }, 401);
    }
    const token = b64uEnc(crypto.getRandomValues(new Uint8Array(32)));
    const now = Date.now();
    const loginResult = await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
      env.DB.prepare("INSERT INTO sessions (token_hash, expires_at) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM meta WHERE key = 'auth_hash' AND value = ?)")
        .bind(await sha256b64u(te.encode(token)), now + SESSION_DAYS * 86_400_000, stored),
      // Giữ tối đa MAX_SESSIONS phiên mới nhất
      env.DB.prepare(
        "DELETE FROM sessions WHERE token_hash NOT IN (SELECT token_hash FROM sessions ORDER BY expires_at DESC LIMIT ?)"
      ).bind(MAX_SESSIONS)
    ]);
    if (loginResult[1].meta.changes !== 1) return json({ error: "account_changed" }, 409);
    return json({ token });
  }

  // ---- Các API dưới đây cần đăng nhập ----
  if (!path.startsWith("/api/")) return json({ error: "not_found" }, 404);
  if (!(await authed(req, env))) return json({ error: "unauthorized" }, 401);

  if (req.method === "POST" && path === "/api/logout") {
    const token = req.headers.get("authorization").slice(7);
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256b64u(te.encode(token))).run();
    return json({ ok: true });
  }

  if (req.method === "GET" && path === "/api/items") {
    const { results } = await env.DB.prepare("SELECT id, rev, iv, ct, updated_at FROM items").all();
    return json({ items: results });
  }

  const m = /^\/api\/items\/(.+)$/.exec(path);
  if (req.method === "PUT" && m) {
    const id = decodeURIComponent(m[1]);
    if (!ID_RE.test(id)) return json({ error: "bad_id" }, 400);
    const { baseRev, iv, ct } = await readJson(req);
    if (!Number.isInteger(baseRev) || baseRev < 0 ||
        typeof iv !== "string" || !B64U_RE.test(iv) || iv.length > 32 ||
        typeof ct !== "string" || !B64U_RE.test(ct) || ct.length > 90_000)
      return json({ error: "bad_request" }, 400);

    const now = Date.now();
    const tokenHash = await sha256b64u(te.encode(req.headers.get("authorization").slice(7)));
    const activeSession = "EXISTS (SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?)";
    const stmt = baseRev === 0
      ? env.DB.prepare(
          "INSERT INTO items (id, rev, iv, ct, updated_at) SELECT ?, 1, ?, ?, ? WHERE " + activeSession + " ON CONFLICT(id) DO NOTHING"
        ).bind(id, iv, ct, now, tokenHash, now)
      : env.DB.prepare(
          "UPDATE items SET rev = rev + 1, iv = ?, ct = ?, updated_at = ? WHERE id = ? AND rev = ? AND " + activeSession
        ).bind(iv, ct, now, id, baseRev, tokenHash, now);
    const res = await stmt.run();
    if (res.meta.changes === 1) return json({ ok: true, rev: baseRev + 1 });
    if (!(await authed(req, env))) return json({ error: "unauthorized" }, 401);

    const cur = await env.DB.prepare("SELECT rev FROM items WHERE id = ?").bind(id).first();
    return json({ error: "conflict", rev: cur?.rev ?? 0 }, 409);
  }

  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(req, env) {
    try {
      return await route(req, env);
    } catch (e) {
      if (e.status) return json({ error: e.message }, e.status);
      return json({ error: "server_error" }, 500);
    }
  }
};
