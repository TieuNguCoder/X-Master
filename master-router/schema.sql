PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  username TEXT,
  channel_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_username
ON sources(lower(username))
WHERE username IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_channel_id
ON sources(channel_id)
WHERE channel_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS children (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'provisioning'
    CHECK(status IN ('provisioning','ready','paused','error')),
  password_hash TEXT NOT NULL,
  child_secret_hash TEXT NOT NULL,
  worker_name TEXT,
  web_url TEXT,
  last_health_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS child_infra (
  child_id TEXT PRIMARY KEY,
  encrypted_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(child_id) REFERENCES children(id) ON DELETE CASCADE
);

-- Durable trigger snapshots and a lease serialize pause/resume/delete.
CREATE TABLE IF NOT EXISTS child_lifecycle (
  child_id TEXT PRIMARY KEY,
  operation_id TEXT,
  action TEXT,
  lease_expires_at TEXT,
  snapshots_json TEXT NOT NULL DEFAULT '{}',
  verified_status TEXT,
  last_error TEXT,
  FOREIGN KEY(child_id) REFERENCES children(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS child_sources (
  child_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(child_id, source_id),
  FOREIGN KEY(child_id) REFERENCES children(id) ON DELETE CASCADE,
  FOREIGN KEY(source_id) REFERENCES sources(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS child_settings (
  child_id TEXT PRIMARY KEY,
  encrypted_json TEXT,
  buffer_channel_id TEXT,
  buffer_channel_name TEXT,
  content_mode TEXT NOT NULL DEFAULT 'news'
    CHECK(content_mode IN ('news','airdrop')),
  x_premium INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(child_id) REFERENCES children(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS child_sessions (
  id TEXT PRIMARY KEY,
  child_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(child_id) REFERENCES children(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deployment_jobs (
  id TEXT PRIMARY KEY,
  child_id TEXT,
  action TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK(status IN ('running','success','failed','rolled_back')),
  step TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  FOREIGN KEY(child_id) REFERENCES children(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_children_status ON children(status);
CREATE INDEX IF NOT EXISTS idx_child_sources_source ON child_sources(source_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);


CREATE TABLE IF NOT EXISTS ingest_events (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  external_id TEXT,
  text_content TEXT,
  media_json TEXT,
  routed_children_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accepted',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(source_id) REFERENCES sources(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ingest_dedupe
ON ingest_events(source_id, external_id)
WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ingest_created
ON ingest_events(created_at DESC);


-- v0.2 multi-account model: each Child Web can manage up to 5 X accounts.
CREATE TABLE IF NOT EXISTS x_accounts (
  id TEXT PRIMARY KEY,
  child_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  x_handle TEXT,
  encrypted_json TEXT,
  buffer_channel_id TEXT,
  buffer_channel_name TEXT,
  content_mode TEXT NOT NULL DEFAULT 'news'
    CHECK(content_mode IN ('news','airdrop')),
  x_premium INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(child_id) REFERENCES children(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_x_accounts_child
ON x_accounts(child_id, created_at);

CREATE TABLE IF NOT EXISTS child_router_slots (
  id TEXT PRIMARY KEY,
  child_id TEXT NOT NULL,
  slot_index INTEGER NOT NULL
    CHECK(slot_index BETWEEN 1 AND 5),
  account_id TEXT UNIQUE,
  worker_name TEXT NOT NULL,
  web_url TEXT,
  router_secret_hash TEXT NOT NULL,
  encrypted_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'provisioning'
    CHECK(status IN ('provisioning','ready','assigned','error')),
  last_health_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(child_id, slot_index),
  FOREIGN KEY(child_id) REFERENCES children(id) ON DELETE CASCADE,
  FOREIGN KEY(account_id) REFERENCES x_accounts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_child_router_slots_child
ON child_router_slots(child_id, slot_index);

CREATE INDEX IF NOT EXISTS idx_child_router_slots_account
ON child_router_slots(account_id)
WHERE account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS x_account_sources (
  account_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(account_id, source_id),
  FOREIGN KEY(account_id) REFERENCES x_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY(source_id) REFERENCES sources(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_x_account_sources_source
ON x_account_sources(source_id, account_id);

CREATE TABLE IF NOT EXISTS ingest_account_routes (
  event_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accepted',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(event_id, account_id),
  FOREIGN KEY(event_id) REFERENCES ingest_events(id) ON DELETE CASCADE,
  FOREIGN KEY(account_id) REFERENCES x_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ingest_account_routes_account
ON ingest_account_routes(account_id, created_at DESC);
