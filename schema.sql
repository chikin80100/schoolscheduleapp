-- 同期グループ。同期コードを共有する端末は、この 1 行の時間割を見る。
-- rev はサーバ側で単調増加させる版番号。端末間の時計ズレに影響されずに新旧を比べられる。
CREATE TABLE IF NOT EXISTS groups (
  code       TEXT PRIMARY KEY,
  json       TEXT NOT NULL,
  rev        INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

-- 端末。通知を使わない端末は endpoint/p256dh/auth が NULL のまま同期だけ行う。
CREATE TABLE IF NOT EXISTS devices (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  endpoint   TEXT,
  p256dh     TEXT,
  auth       TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (code) REFERENCES groups(code) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS devices_by_code ON devices(code);
