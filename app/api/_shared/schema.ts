import { env } from "cloudflare:workers";
import { DEFAULT_TIME_ZONE } from "../../dateTime";
import { DEFAULT_HOUSEHOLD_ID } from "./householdId";
import { once } from "./once";

/**
 * 全项目唯一的建表来源。
 *
 * 语句按固定顺序执行：先建表，再建索引，然后补列，最后才是种子数据和回填。
 * 顺序是必需的，因为回填会跨表读取（把 recipe_favorites 的旧数据搬进 recipe_catalog），
 * 只有全部表都存在时才成立。
 *
 * 以前每个路由各自维护自己用到的那几张表。结果是同一张表在两处重复定义，
 * 而跨表的回填语句依赖了别的路由才会建的表，谁先被访问决定了会不会报错。
 */

const TABLES = [
  `CREATE TABLE IF NOT EXISTS inventory_items (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '未分类',
    precision TEXT NOT NULL DEFAULT 'quantity',
    quantity REAL NOT NULL DEFAULT 1,
    unit TEXT NOT NULL DEFAULT '件',
    remaining_percent INTEGER NOT NULL DEFAULT 100,
    level TEXT NOT NULL DEFAULT '充足',
    purchase_date TEXT,
    expiry_date TEXT,
    opened_date TEXT,
    opened_shelf_life_days INTEGER,
    note TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS inventory_attachments (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    object_key TEXT NOT NULL,
    file_name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS purchase_records (
    id TEXT PRIMARY KEY,
    inventory_id TEXT,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '其他',
    quantity REAL NOT NULL DEFAULT 1,
    unit TEXT NOT NULL DEFAULT '件',
    unit_price REAL NOT NULL DEFAULT 0,
    regular_unit_price REAL,
    line_total REAL NOT NULL DEFAULT 0,
    store TEXT NOT NULL DEFAULT '',
    purchase_date TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'receipt',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS household_settings (
    id INTEGER PRIMARY KEY DEFAULT 1,
    city TEXT NOT NULL DEFAULT '',
    postal_code TEXT NOT NULL DEFAULT '',
    food_budget REAL NOT NULL DEFAULT 0,
    household_budget REAL NOT NULL DEFAULT 0,
    max_stores INTEGER NOT NULL DEFAULT 2,
    timezone TEXT NOT NULL DEFAULT '${DEFAULT_TIME_ZONE}',
    household_id TEXT NOT NULL DEFAULT '${DEFAULT_HOUSEHOLD_ID}',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS stores (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    source_key TEXT,
    flyer_url TEXT NOT NULL DEFAULT '',
    flyer_format TEXT NOT NULL DEFAULT 'manual',
    last_synced_at TEXT,
    is_favorite INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS flyer_deals (
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
  )`,
  `CREATE TABLE IF NOT EXISTS flyer_sync_settings (
    id INTEGER PRIMARY KEY DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    interval_hours INTEGER NOT NULL DEFAULT 24,
    next_sync_at TEXT,
    last_started_at TEXT,
    last_completed_at TEXT,
    last_status TEXT NOT NULL DEFAULT 'never',
    last_message TEXT NOT NULL DEFAULT '尚未自动同步',
    deals_imported INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS flyer_deal_metadata (
    deal_id TEXT PRIMARY KEY,
    item_key TEXT NOT NULL DEFAULT '',
    package_quantity REAL,
    package_unit TEXT NOT NULL DEFAULT '',
    confidence TEXT NOT NULL DEFAULT 'medium',
    verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_saved INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS flyer_price_history (
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
  )`,
  `CREATE TABLE IF NOT EXISTS flyer_match_rules (
    id TEXT PRIMARY KEY,
    inventory_name TEXT NOT NULL,
    deal_pattern TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    match_kind TEXT NOT NULL DEFAULT 'substitute',
    active INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS flyer_recommendation_feedback (
    id TEXT PRIMARY KEY,
    deal_id TEXT,
    item_pattern TEXT NOT NULL DEFAULT '',
    store_id TEXT,
    action TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS shopping_items (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    quantity REAL NOT NULL DEFAULT 1,
    unit TEXT NOT NULL DEFAULT '件',
    category TEXT NOT NULL DEFAULT '其他',
    checked INTEGER NOT NULL DEFAULT 0,
    stocked INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS recipe_suggestions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT '库存优先',
    icon TEXT NOT NULL DEFAULT '🍲',
    cook_time TEXT NOT NULL DEFAULT '30 分钟',
    difficulty TEXT NOT NULL DEFAULT '简单',
    servings INTEGER NOT NULL DEFAULT 2,
    ingredients_json TEXT NOT NULL DEFAULT '[]',
    steps_json TEXT NOT NULL DEFAULT '[]',
    generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS recipe_favorites (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT '库存优先',
    icon TEXT NOT NULL DEFAULT '🍲',
    cook_time TEXT NOT NULL DEFAULT '30 分钟',
    difficulty TEXT NOT NULL DEFAULT '简单',
    servings INTEGER NOT NULL DEFAULT 2,
    ingredients_json TEXT NOT NULL DEFAULT '[]',
    steps_json TEXT NOT NULL DEFAULT '[]',
    favorited_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS recipe_catalog (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT '家庭自建', icon TEXT NOT NULL DEFAULT '🍲', cook_time TEXT NOT NULL DEFAULT '30 分钟',
    difficulty TEXT NOT NULL DEFAULT '简单', servings INTEGER NOT NULL DEFAULT 2, ingredients_json TEXT NOT NULL DEFAULT '[]',
    steps_json TEXT NOT NULL DEFAULT '[]', tags_json TEXT NOT NULL DEFAULT '[]', meal_types_json TEXT NOT NULL DEFAULT '[]',
    is_favorite INTEGER NOT NULL DEFAULT 0, is_custom INTEGER NOT NULL DEFAULT 0, cooked_count INTEGER NOT NULL DEFAULT 0,
    last_cooked_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS recipe_attachments (
    id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL, object_key TEXT NOT NULL, file_name TEXT NOT NULL,
    content_type TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS recipe_preferences (
    id INTEGER PRIMARY KEY, allergies TEXT NOT NULL DEFAULT '', avoid_foods TEXT NOT NULL DEFAULT '',
    dislikes TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
    household_id TEXT NOT NULL DEFAULT '${DEFAULT_HOUSEHOLD_ID}',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS household_members (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT NOT NULL DEFAULT '🙂',
    household_id TEXT NOT NULL DEFAULT '${DEFAULT_HOUSEHOLD_ID}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS meal_requests (
    id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL, member_id TEXT NOT NULL, desired_from TEXT, desired_to TEXT,
    meal_type TEXT NOT NULL DEFAULT '', priority TEXT NOT NULL DEFAULT '想吃', servings INTEGER NOT NULL DEFAULT 2,
    notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'candidate', scheduled_date TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS recipe_cook_history (
    id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL, request_id TEXT, cooked_date TEXT NOT NULL, meal_type TEXT NOT NULL DEFAULT '',
    servings INTEGER NOT NULL DEFAULT 2, cook_member_id TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
    consumption_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS recipe_ratings (
    id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL, member_id TEXT NOT NULL, rating INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS recipe_activity_log (
    id TEXT PRIMARY KEY, recipe_id TEXT, member_id TEXT, action TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
];

const INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_inventory_attachments_item_id ON inventory_attachments(item_id)",
  "CREATE INDEX IF NOT EXISTS idx_purchase_records_date ON purchase_records(purchase_date)",
  "CREATE INDEX IF NOT EXISTS idx_purchase_records_name ON purchase_records(name)",
  "CREATE INDEX IF NOT EXISTS idx_flyer_deals_valid_to ON flyer_deals(valid_to)",
  "CREATE INDEX IF NOT EXISTS idx_flyer_deals_store_source ON flyer_deals(store_id, source)",
  "CREATE INDEX IF NOT EXISTS idx_stores_source_key ON stores(source_key)",
  "CREATE INDEX IF NOT EXISTS idx_shopping_items_checked ON shopping_items(checked)",
  "CREATE INDEX IF NOT EXISTS idx_flyer_price_history_item_store ON flyer_price_history(item_key, store_id, observed_at)",
  "CREATE INDEX IF NOT EXISTS idx_flyer_price_history_deal ON flyer_price_history(deal_id)",
  "CREATE INDEX IF NOT EXISTS idx_flyer_match_rules_pattern ON flyer_match_rules(deal_pattern, active)",
  "CREATE INDEX IF NOT EXISTS idx_flyer_feedback_action_pattern ON flyer_recommendation_feedback(action, item_pattern)",
  "CREATE INDEX IF NOT EXISTS idx_recipe_favorites_favorited_at ON recipe_favorites(favorited_at)",
  "CREATE INDEX IF NOT EXISTS idx_recipe_catalog_updated_at ON recipe_catalog(updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_meal_requests_status_date ON meal_requests(status, scheduled_date)",
  "CREATE INDEX IF NOT EXISTS idx_recipe_cook_history_recipe_date ON recipe_cook_history(recipe_id, cooked_date)",
  "CREATE INDEX IF NOT EXISTS idx_recipe_ratings_recipe_id ON recipe_ratings(recipe_id)",
  "CREATE INDEX IF NOT EXISTS idx_recipe_activity_log_created_at ON recipe_activity_log(created_at)",
  "CREATE INDEX IF NOT EXISTS idx_recipe_attachments_recipe_id ON recipe_attachments(recipe_id)",
];

/**
 * 建在补列之上的索引。
 *
 * 不能和建表放在同一个 batch 里：老库上那些列要等下面的 ALTER 执行完才存在，
 * 索引会先一步失败，整个建表流程随之中断，每个请求都报 no such column。
 */
const INDEXES_ON_ADDED_COLUMNS = [
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_household_settings_household ON household_settings(household_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_recipe_preferences_household ON recipe_preferences(household_id)",
  "CREATE INDEX IF NOT EXISTS idx_household_members_household ON household_members(household_id)",
];

/**
 * 后来才加的列。上面的 CREATE TABLE 里已经写了同样的定义，新库不会走到这里，
 * 只有在这些列出现之前就建好的库才需要补。
 */
const ADDED_COLUMNS: Array<{ table: string; column: string; ddl: string; backfill?: string }> = [
  {
    table: "inventory_items",
    column: "purchase_date",
    ddl: "ALTER TABLE inventory_items ADD COLUMN purchase_date TEXT",
  },
  {
    table: "inventory_items",
    column: "remaining_percent",
    ddl: "ALTER TABLE inventory_items ADD COLUMN remaining_percent INTEGER NOT NULL DEFAULT 100",
    backfill: "UPDATE inventory_items SET remaining_percent = 0 WHERE quantity <= 0 OR level = '已用完'",
  },
  {
    table: "inventory_items",
    column: "opened_date",
    ddl: "ALTER TABLE inventory_items ADD COLUMN opened_date TEXT",
  },
  {
    table: "inventory_items",
    column: "opened_shelf_life_days",
    ddl: "ALTER TABLE inventory_items ADD COLUMN opened_shelf_life_days INTEGER",
  },
  {
    // 时区原先写死在代码里，改成按家庭设置，老库需要补上这一列。
    table: "household_settings",
    column: "timezone",
    ddl: `ALTER TABLE household_settings ADD COLUMN timezone TEXT NOT NULL DEFAULT '${DEFAULT_TIME_ZONE}'`,
  },
  ...["household_settings", "recipe_preferences", "household_members"].map((table) => ({
    // 多住户改造：已有数据全部归到默认住户，带默认值的加列会一次填好。
    table,
    column: "household_id",
    ddl: `ALTER TABLE ${table} ADD COLUMN household_id TEXT NOT NULL DEFAULT '${DEFAULT_HOUSEHOLD_ID}'`,
  })),
  {
    // 「已买」和「已入库」是两回事，stocked 是后加的列。
    table: "shopping_items",
    column: "stocked",
    ddl: "ALTER TABLE shopping_items ADD COLUMN stocked INTEGER NOT NULL DEFAULT 0",
  },
  {
    // 扣库存的快照是后加的，老库里没有这一列。
    table: "recipe_cook_history",
    column: "consumption_json",
    ddl: "ALTER TABLE recipe_cook_history ADD COLUMN consumption_json TEXT NOT NULL DEFAULT '[]'",
  },
];

/**
 * 种子行，以及把早期的 recipe_favorites / recipe_suggestions 合并进 recipe_catalog 的回填。
 * 这些语句跨表读写，必须排在所有建表之后。
 */
const SEEDS = [
  "DELETE FROM recipe_favorites WHERE id IN (SELECT recipe_id FROM recipe_activity_log WHERE action = '删除菜谱' AND recipe_id IS NOT NULL)",
  "DELETE FROM recipe_suggestions WHERE id IN (SELECT recipe_id FROM recipe_activity_log WHERE action = '删除菜谱' AND recipe_id IS NOT NULL)",
  "DELETE FROM recipe_catalog WHERE id IN (SELECT recipe_id FROM recipe_activity_log WHERE action = '删除菜谱' AND recipe_id IS NOT NULL)",
  `INSERT OR IGNORE INTO recipe_catalog
    (id, title, summary, reason, origin, icon, cook_time, difficulty, servings, ingredients_json, steps_json, tags_json, meal_types_json, is_favorite, is_custom)
    SELECT id, title, summary, reason, origin, icon, cook_time, difficulty, servings, ingredients_json, steps_json,
    '["已收藏"]', '[]', 1, 0 FROM recipe_favorites`,
  `INSERT OR IGNORE INTO recipe_catalog
    (id, title, summary, reason, origin, icon, cook_time, difficulty, servings, ingredients_json, steps_json, tags_json, meal_types_json, is_favorite, is_custom)
    SELECT id, title, summary, reason, origin, icon, cook_time, difficulty, servings, ingredients_json, steps_json,
    '["智能推荐"]', '[]', 0, 0 FROM recipe_suggestions`,
  "PRAGMA optimize",
];

/** 导出给测试使用，省得测试再维护一份表名清单。 */
export const TABLE_NAMES = TABLES.flatMap((ddl) => /IF NOT EXISTS (\w+)/.exec(ddl)?.slice(1, 2) ?? []);

async function missingColumns() {
  const tables = [...new Set(ADDED_COLUMNS.map((entry) => entry.table))];
  const infos = await env.DB.batch<{ name: string }>(
    tables.map((table) => env.DB.prepare(`PRAGMA table_info(${table})`)),
  );
  const present = new Map(tables.map((table, index) => [table, infos[index].results.map((r) => r.name)]));
  return ADDED_COLUMNS.filter((entry) => !present.get(entry.table)?.includes(entry.column));
}

export const ensureSchema = once(async () => {
  await env.DB.batch([...TABLES, ...INDEXES].map((ddl) => env.DB.prepare(ddl)));

  // 补列不放进 batch：backfill 需要看到刚加上的列，而 batch 是一个事务一次提交。
  for (const entry of await missingColumns()) {
    await env.DB.prepare(entry.ddl).run();
    if (entry.backfill) await env.DB.prepare(entry.backfill).run();
  }

  await env.DB.batch(INDEXES_ON_ADDED_COLUMNS.map((ddl) => env.DB.prepare(ddl)));
  await env.DB.batch(SEEDS.map((sql) => env.DB.prepare(sql)));
});
