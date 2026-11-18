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

// ---- Chống dò mật khẩu ----
async function tooManyAttempts(env, ip) {
  const since = Date.now() - 15 * 60_000;
  const mine = await env.DB.prepare("SELECT COUNT(*) AS c FROM attempts WHERE ip = ? AND at > ?").bind(ip, since).first();
  const all = await env.DB.prepare("SELECT COUNT(*) AS c FROM attempts WHERE at > ?").bind(since).first();
  return mine.c >= 5 || all.c >= 30;
}
async function recordFailure(env, ip) {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO attempts (ip, at) VALUES (?, ?)").bind(ip, Date.now()),
    env.DB.prepare("DELETE FROM attempts WHERE at < ?").bind(Date.now() - 86_400_000)
  ]);
}

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
  const ip = req.headers.get("cf-connecting-ip") || "unknown";

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (req.method === "GET" && path === "/")
    return new Response(HOME, { headers: { "content-type": "text/html; charset=utf-8" } });

  if (req.method === "GET" && path === "/api/status") {
    const salt = await getMeta(env, "salt");
    return json({ registered: !!salt, salt: salt || null });
  }

  if (req.method === "POST" && path === "/api/register") {
    const body = await readJson(req);
    if (!env.SETUP_CODE) return json({ error: "setup_code_missing" }, 503);
    if (await getMeta(env, "salt")) return json({ error: "already_registered" }, 409);
    if (await tooManyAttempts(env, ip)) return json({ error: "too_many_attempts" }, 429);

    const okCode = typeof body.setupCode === "string" && (await safeEqual(body.setupCode, env.SETUP_CODE));
    if (!okCode) {
      await recordFailure(env, ip);
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
    if (await tooManyAttempts(env, ip)) return json({ error: "too_many_attempts" }, 429);
    const body = await readJson(req);
    const stored = await getMeta(env, "auth_hash");
    let ok = false;
    if (stored && typeof body.authKey === "string" && B64U_RE.test(body.authKey) && body.authKey.length === 43)
      ok = await safeEqual(await sha256b64u(b64uDec(body.authKey)), stored);
    if (!ok) {
      await recordFailure(env, ip);
      return json({ error: "bad_credentials" }, 401);
    }
    const token = b64uEnc(crypto.getRandomValues(new Uint8Array(32)));
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
      env.DB.prepare("INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)")
        .bind(await sha256b64u(te.encode(token)), now + SESSION_DAYS * 86_400_000),
      // Giữ tối đa MAX_SESSIONS phiên mới nhất
      env.DB.prepare(
        "DELETE FROM sessions WHERE token_hash NOT IN (SELECT token_hash FROM sessions ORDER BY expires_at DESC LIMIT ?)"
      ).bind(MAX_SESSIONS)
    ]);
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
    const stmt = baseRev === 0
      ? env.DB.prepare(
          "INSERT INTO items (id, rev, iv, ct, updated_at) VALUES (?, 1, ?, ?, ?) ON CONFLICT(id) DO NOTHING"
        ).bind(id, iv, ct, now)
      : env.DB.prepare(
          "UPDATE items SET rev = rev + 1, iv = ?, ct = ?, updated_at = ? WHERE id = ? AND rev = ?"
        ).bind(iv, ct, now, id, baseRev);
    const res = await stmt.run();
    if (res.meta.changes === 1) return json({ ok: true, rev: baseRev + 1 });

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
