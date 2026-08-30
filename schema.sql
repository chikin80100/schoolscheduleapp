-- 端末ごとの購読情報。
CREATE TABLE IF NOT EXISTS devices (
  id         TEXT PRIMARY KEY,
  endpoint   TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 端末ごとの時間割（通知の文面を組み立てるために保存する）。
CREATE TABLE IF NOT EXISTS schedules (
  device_id  TEXT PRIMARY KEY,
  json       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);
