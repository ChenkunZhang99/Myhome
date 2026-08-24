-- A deliberately incomplete pre-version schema. The integration runner loads
-- this into an isolated local D1 before the Worker starts.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  household_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT
);

INSERT INTO users (id, email, household_id)
VALUES ('legacy-user', 'legacy@e2e.test', 'household-default');

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'session',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO sessions (token_hash, user_id, expires_at)
VALUES ('legacy-token', 'legacy-user', '2099-01-01T00:00:00.000Z');

CREATE TABLE inventory_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '未分类',
  precision TEXT NOT NULL DEFAULT 'quantity',
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT '件',
  level TEXT NOT NULL DEFAULT '充足',
  expiry_date TEXT,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO inventory_items (id, name, category, quantity, level)
VALUES ('legacy-empty-item', '旧库存', '测试', 0, '已用完');

CREATE TABLE household_settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  city TEXT NOT NULL DEFAULT '',
  postal_code TEXT NOT NULL DEFAULT '',
  food_budget REAL NOT NULL DEFAULT 0,
  household_budget REAL NOT NULL DEFAULT 0,
  max_stores INTEGER NOT NULL DEFAULT 2,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE shopping_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT '件',
  category TEXT NOT NULL DEFAULT '其他',
  checked INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE flyer_sources (
  source_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  flyer_url TEXT NOT NULL DEFAULT '',
  flyer_format TEXT NOT NULL DEFAULT 'manual',
  timezone TEXT NOT NULL DEFAULT 'America/Vancouver',
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE flyer_deals (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '其他',
  price REAL NOT NULL,
  regular_price REAL,
  unit TEXT NOT NULL DEFAULT '件',
  valid_from TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  source_url TEXT NOT NULL DEFAULT '',
  source_fingerprint TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE flyer_price_history (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  item_name TEXT NOT NULL,
  price REAL NOT NULL,
  regular_price REAL,
  unit TEXT NOT NULL DEFAULT '件',
  package_quantity REAL,
  package_unit TEXT NOT NULL DEFAULT '',
  valid_from TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE flyer_recommendation_feedback (
  id TEXT PRIMARY KEY,
  deal_id TEXT,
  store_id TEXT,
  item_pattern TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE stores (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE recipe_suggestions (id TEXT PRIMARY KEY, title TEXT NOT NULL);
CREATE TABLE recipe_favorites (id TEXT PRIMARY KEY, title TEXT NOT NULL);
