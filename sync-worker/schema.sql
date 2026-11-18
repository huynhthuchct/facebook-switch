-- Dữ liệu đã được mã hoá ở phía extension; server không thấy nội dung gốc.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id         TEXT PRIMARY KEY,
  rev        INTEGER NOT NULL,
  iv         TEXT NOT NULL,
  ct         TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  at INTEGER NOT NULL
);
