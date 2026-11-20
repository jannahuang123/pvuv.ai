-- Order and checkout-failure notices.
--
-- A goal event (order / order_failed, …) is not useful on its own: the owner
-- wants the path that led there (where they came from, which pages, where they
-- left) pushed out as a message, and an agent needs the same record to suggest
-- what to change. One row per event id, so a queue redelivery does not send
-- the message twice.

CREATE TABLE IF NOT EXISTS journey_notices (
  notice_id   TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL,
  eid         TEXT NOT NULL,
  visitor_id  TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  user_id     TEXT,
  kind        TEXT NOT NULL,
  event       TEXT NOT NULL,
  revenue     REAL,
  currency    TEXT,
  source      TEXT,
  medium      TEXT,
  campaign    TEXT,
  referrer    TEXT,
  channel     TEXT,
  entry_page  TEXT,
  exit_page   TEXT,
  country     TEXT,
  device_type TEXT,
  path        TEXT NOT NULL,
  message     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  notified_at INTEGER,
  UNIQUE (site_id, eid)
);
CREATE INDEX IF NOT EXISTS idx_journey_site_created ON journey_notices(site_id, created_at);
