import { env } from "cloudflare:workers";
import { DEFAULT_TIME_ZONE } from "../../dateTime";
import { FLYER_SOURCES } from "./flyerSources";
import { DEFAULT_HOUSEHOLD_ID } from "./householdId";
import { once } from "./once";

/**
 * 全项目唯一的建表来源。
 *
 * 语句按固定顺序执行：先建表，再建索引，然后补列，最后才是种子数据。
 * 顺序是必需的，因为种子里的清理语句会跨表读取，只有全部表都存在时才成立。
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
    household_id TEXT NOT NULL DEFAULT '${DEFAULT_HOUSEHOLD_ID}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS inventory_attachments (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    household_id TEXT NOT NULL DEFAULT '${DEFAULT_HOUSEHOLD_ID}',
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
    household_id TEXT NOT NULL DEFAULT '${DEFAULT_HOUSEHOLD_ID}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    household_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT,
    -- 密码是可选的：不设就只能用邮箱链接登录，设了两种都行。
    password_hash TEXT,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    -- owner 是开这个家的人，member 是被邀请进来的。两者看到的数据完全一样，
    -- 区别只在能不能把别人请出去。
    role TEXT NOT NULL DEFAULT 'owner'
  )`,
  `CREATE TABLE IF NOT EXISTS ai_quota (
    -- 每个家在服务端那把密钥上用掉了几次。用满了就得填自己的。
    household_id TEXT PRIMARY KEY,
    used INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS households (
    id TEXT PRIMARY KEY,
    -- 家有名字才能在切换器里被认出来。同一个人可能同时在「我家」和「爸妈家」。
    name TEXT NOT NULL DEFAULT '我们的家',
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS household_memberships (
    user_id TEXT NOT NULL,
    household_id TEXT NOT NULL,
    -- owner 能改家庭设置、发邀请、请人出去；member 只是看得见同一份数据。
    role TEXT NOT NULL DEFAULT 'member',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, household_id)
  )`,
  `CREATE TABLE IF NOT EXISTS household_invites (
    token_hash TEXT PRIMARY KEY,
    household_id TEXT NOT NULL,
    invited_by TEXT NOT NULL,
    -- 填了就只有这个邮箱能接受，留空则谁拿到链接都能进
    email TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    accepted_at TEXT,
    accepted_by TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'session',
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    user_agent TEXT NOT NULL DEFAULT ''
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
  `CREATE TABLE IF NOT EXISTS flyer_sources (
    source_key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    flyer_url TEXT NOT NULL DEFAULT '',
    flyer_format TEXT NOT NULL DEFAULT 'manual',
    timezone TEXT NOT NULL DEFAULT '${DEFAULT_TIME_ZONE}',
    last_synced_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS flyer_source_areas (
    -- 加拿大 FSA（邮编前三位，V3J）或美国 ZIP 前三位。一个片区大致就是一个街区，
    -- 按它缓存刚好：同一片区的第二个人直接命中，不用再让模型搜一次。
    area TEXT NOT NULL,
    source_key TEXT NOT NULL,
    discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- 谁把这家店带进目录的。目录是全局的，出了脏数据要追得回来。
    discovered_by TEXT,
    PRIMARY KEY (area, source_key)
  )`,
  `CREATE TABLE IF NOT EXISTS household_stores (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL DEFAULT '${DEFAULT_HOUSEHOLD_ID}',
    source_key TEXT NOT NULL,
    name TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    is_favorite INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS flyer_deals (
    id TEXT PRIMARY KEY,
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
    household_id TEXT NOT NULL DEFAULT '${DEFAULT_HOUSEHOLD_ID}',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS flyer_recommendation_feedback (
    id TEXT PRIMARY KEY,
    deal_id TEXT,
    item_pattern TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    household_id TEXT NOT NULL DEFAULT '${DEFAULT_HOUSEHOLD_ID}',
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
    household_id TEXT NOT NULL DEFAULT '${DEFAULT_HOUSEHOLD_ID}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS recipe_catalog (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT '家庭自建', icon TEXT NOT NULL DEFAULT '🍲', cook_time TEXT NOT NULL DEFAULT '30 分钟',
    difficulty TEXT NOT NULL DEFAULT '简单', servings INTEGER NOT NULL DEFAULT 2, ingredients_json TEXT NOT NULL DEFAULT '[]',
    steps_json TEXT NOT NULL DEFAULT '[]', tags_json TEXT NOT NULL DEFAULT '[]', meal_types_json TEXT NOT NULL DEFAULT '[]',
    is_favorite INTEGER NOT NULL DEFAULT 0, is_custom INTEGER NOT NULL DEFAULT 0, cooked_count INTEGER NOT NULL DEFAULT 0,
    last_cooked_at TEXT, household_id TEXT NOT NULL DEFAULT '${DEFAULT_HOUSEHOLD_ID}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS recipe_attachments (
    id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL, object_key TEXT NOT NULL, file_name TEXT NOT NULL,
    content_type TEXT NOT NULL, size INTEGER NOT NULL,
    household_id TEXT NOT NULL DEFAULT '${DEFAULT_HOUSEHOLD_ID}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
    household_id TEXT NOT NULL DEFAULT '${DEFAULT_HOUSEHOLD_ID}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS recipe_cook_history (
    id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL, request_id TEXT, cooked_date TEXT NOT NULL, meal_type TEXT NOT NULL DEFAULT '',
    servings INTEGER NOT NULL DEFAULT 2, cook_member_id TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
    consumption_json TEXT NOT NULL DEFAULT '[]',
    household_id TEXT NOT NULL DEFAULT '${DEFAULT_HOUSEHOLD_ID}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS recipe_ratings (
    id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL, member_id TEXT NOT NULL, rating INTEGER NOT NULL,
    household_id TEXT NOT NULL DEFAULT '${DEFAULT_HOUSEHOLD_ID}',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS recipe_activity_log (
    id TEXT PRIMARY KEY, recipe_id TEXT, member_id TEXT, action TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}',
    household_id TEXT NOT NULL DEFAULT '${DEFAULT_HOUSEHOLD_ID}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
];

const INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_inventory_attachments_item_id ON inventory_attachments(item_id)",
  "CREATE INDEX IF NOT EXISTS idx_purchase_records_date ON purchase_records(purchase_date)",
  "CREATE INDEX IF NOT EXISTS idx_purchase_records_name ON purchase_records(name)",
  "CREATE INDEX IF NOT EXISTS idx_flyer_deals_valid_to ON flyer_deals(valid_to)",
  "CREATE INDEX IF NOT EXISTS idx_household_stores_household ON household_stores(household_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_household_stores_subscription ON household_stores(household_id, source_key)",
  "CREATE INDEX IF NOT EXISTS idx_shopping_items_checked ON shopping_items(checked)",
  "CREATE INDEX IF NOT EXISTS idx_flyer_price_history_deal ON flyer_price_history(deal_id)",
  "CREATE INDEX IF NOT EXISTS idx_flyer_match_rules_pattern ON flyer_match_rules(deal_pattern, active)",
  "CREATE INDEX IF NOT EXISTS idx_flyer_feedback_action_pattern ON flyer_recommendation_feedback(action, item_pattern)",
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
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_id ON sessions(session_id)",
  "CREATE INDEX IF NOT EXISTS idx_household_invites_household ON household_invites(household_id)",
  "CREATE INDEX IF NOT EXISTS idx_household_invites_expiry ON household_invites(expires_at)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at)",
  "CREATE INDEX IF NOT EXISTS idx_shopping_items_household ON shopping_items(household_id)",
  "CREATE INDEX IF NOT EXISTS idx_flyer_match_rules_household ON flyer_match_rules(household_id)",
  "CREATE INDEX IF NOT EXISTS idx_flyer_recommendation_feedback_household ON flyer_recommendation_feedback(household_id)",
  "CREATE INDEX IF NOT EXISTS idx_recipe_catalog_household ON recipe_catalog(household_id)",
  "CREATE INDEX IF NOT EXISTS idx_recipe_attachments_household ON recipe_attachments(household_id)",
  "CREATE INDEX IF NOT EXISTS idx_recipe_cook_history_household ON recipe_cook_history(household_id)",
  "CREATE INDEX IF NOT EXISTS idx_recipe_ratings_household ON recipe_ratings(household_id)",
  "CREATE INDEX IF NOT EXISTS idx_recipe_activity_log_household ON recipe_activity_log(household_id)",
  "CREATE INDEX IF NOT EXISTS idx_meal_requests_household ON meal_requests(household_id)",
  "CREATE INDEX IF NOT EXISTS idx_inventory_items_household ON inventory_items(household_id)",
  "CREATE INDEX IF NOT EXISTS idx_inventory_attachments_household ON inventory_attachments(household_id, item_id)",
  "CREATE INDEX IF NOT EXISTS idx_purchase_records_household ON purchase_records(household_id, purchase_date)",
  "CREATE INDEX IF NOT EXISTS idx_flyer_deals_source ON flyer_deals(source_key, valid_to)",
  "CREATE INDEX IF NOT EXISTS idx_flyer_price_history_source ON flyer_price_history(item_key, source_key, observed_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_household_settings_household ON household_settings(household_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_recipe_preferences_household ON recipe_preferences(household_id)",
  "CREATE INDEX IF NOT EXISTS idx_household_members_household ON household_members(household_id)",
  // 切换家庭要按人查「我都属于哪些家」，成员列表要按家查「这家里都有谁」。
  "CREATE INDEX IF NOT EXISTS idx_flyer_source_areas_area ON flyer_source_areas(area)",
  "CREATE INDEX IF NOT EXISTS idx_memberships_user ON household_memberships(user_id)",
  "CREATE INDEX IF NOT EXISTS idx_memberships_household ON household_memberships(household_id, role)",
];

const DISCOVERY_COLUMNS: Array<{ table: string; column: string; ddl: string }> = [
  // 门店目录原本是代码里写死的三家，现在用户可以按邮编搜出新的来。
  // 这三列是为了在目录长大之后还认得出每一行的来历。
  { table: "flyer_sources", column: "chain", ddl: "ALTER TABLE flyer_sources ADD COLUMN chain TEXT" },
  {
    table: "flyer_sources",
    column: "created_by",
    ddl: "ALTER TABLE flyer_sources ADD COLUMN created_by TEXT",
  },
  {
    table: "flyer_sources",
    column: "verified_at",
    ddl: "ALTER TABLE flyer_sources ADD COLUMN verified_at TEXT",
  },
];

/**
 * 后来才加的列。上面的 CREATE TABLE 里已经写了同样的定义，新库不会走到这里，
 * 只有在这些列出现之前就建好的库才需要补。
 */
const ADDED_COLUMNS: Array<{ table: string; column: string; ddl: string; backfill?: string }> = [
  ...DISCOVERY_COLUMNS,
  {
    table: "sessions",
    column: "session_id",
    ddl: "ALTER TABLE sessions ADD COLUMN session_id TEXT",
    backfill:
      "UPDATE sessions SET session_id = lower(hex(randomblob(16))) WHERE session_id IS NULL OR session_id = ''",
  },
  {
    table: "sessions",
    column: "last_seen_at",
    ddl: "ALTER TABLE sessions ADD COLUMN last_seen_at TEXT",
    backfill: "UPDATE sessions SET last_seen_at = created_at WHERE last_seen_at IS NULL",
  },
  {
    table: "sessions",
    column: "user_agent",
    ddl: "ALTER TABLE sessions ADD COLUMN user_agent TEXT NOT NULL DEFAULT ''",
  },
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
  ...[
    // 密码登录是后加的。老库里的 users 表没有这三列，补上；
    // password_hash 为空就表示这个账号只用邮箱链接登录。
    { column: "password_hash", ddl: "ALTER TABLE users ADD COLUMN password_hash TEXT" },
    {
      column: "failed_logins",
      ddl: "ALTER TABLE users ADD COLUMN failed_logins INTEGER NOT NULL DEFAULT 0",
    },
    { column: "locked_until", ddl: "ALTER TABLE users ADD COLUMN locked_until TEXT" },
    {
      column: "role",
      ddl: "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'owner'",
    },
  ].map((entry) => ({ table: "users", ...entry })),
  {
    // 时区原先写死在代码里，改成按家庭设置，老库需要补上这一列。
    table: "household_settings",
    column: "timezone",
    ddl: `ALTER TABLE household_settings ADD COLUMN timezone TEXT NOT NULL DEFAULT '${DEFAULT_TIME_ZONE}'`,
  },
  ...["shopping_items", "flyer_match_rules", "flyer_recommendation_feedback"].map((table) => ({
    table,
    column: "household_id",
    ddl: `ALTER TABLE ${table} ADD COLUMN household_id TEXT NOT NULL DEFAULT '${DEFAULT_HOUSEHOLD_ID}'`,
  })),
  ...[
    "recipe_catalog",
    "recipe_attachments",
    "recipe_cook_history",
    "recipe_ratings",
    "recipe_activity_log",
    "meal_requests",
  ].map((table) => ({
    table,
    column: "household_id",
    ddl: `ALTER TABLE ${table} ADD COLUMN household_id TEXT NOT NULL DEFAULT '${DEFAULT_HOUSEHOLD_ID}'`,
  })),
  ...["inventory_items", "inventory_attachments", "purchase_records"].map((table) => ({
    table,
    column: "household_id",
    ddl: `ALTER TABLE ${table} ADD COLUMN household_id TEXT NOT NULL DEFAULT '${DEFAULT_HOUSEHOLD_ID}'`,
  })),
  ...["flyer_deals", "flyer_price_history", "flyer_recommendation_feedback"].map((table) => ({
    // flyer 数据改为挂在「来源」上而不是某一户的门店行上，同一份优惠所有人共享。
    table,
    column: "source_key",
    ddl: `ALTER TABLE ${table} ADD COLUMN source_key TEXT NOT NULL DEFAULT ''`,
  })),
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
 * 种子与清理语句。它们跨表读写，必须排在所有建表之后。
 */
const SEEDS = [
  /*
   * 代码里预设的那几家也要能被邮编搜到。
   *
   * 它们的地址里就带着邮编，取前三位当片区。不做这一步的话，Lougheed 一带的
   * 用户搜出来的是一份不包含 PriceSmart 的列表——而那恰恰是这个项目里
   * 唯一有结构化抓取、读得最准的一家。
   *
   * 正则在 SQLite 里没有，用 SUBSTR + INSTR 找地址里最后那个「字母数字 空格 数字」的邮编段。
   * 写得笨一点没关系，这条只在建表时跑一次，而且是幂等的。
   */
  `INSERT OR IGNORE INTO flyer_source_areas (area, source_key, discovered_by)
   SELECT UPPER(REPLACE(SUBSTR(address, LENGTH(address) - 6, 3), ' ', '')), source_key, 'preset'
     FROM flyer_sources
    WHERE created_by IS NULL
      AND LENGTH(address) > 7
      AND SUBSTR(address, LENGTH(address) - 6, 1) BETWEEN 'A' AND 'Z'`,
  /*
   * 从「一人一家」迁到「一人多家」。
   *
   * users.household_id 没有消失，它的含义变了：从「我属于哪个家」变成
   * 「我现在正在看哪个家」。谁能进哪个家，改由 household_memberships 说了算。
   *
   * 这样改的理由是省下一百多条 SQL：resolveHousehold 仍然从 users.household_id
   * 取值，所有带 household_id 的查询一条都不用动。切换家庭变成「验一下有没有
   * membership，然后改这个指针」。
   *
   * 两条都是 INSERT OR IGNORE，跑多少次结果都一样。
   */
  "INSERT OR IGNORE INTO households (id, name) SELECT DISTINCT household_id, '我们的家' FROM users",
  "INSERT OR IGNORE INTO household_memberships (user_id, household_id, role) SELECT id, household_id, role FROM users",
  // 删除菜谱时留下的墓碑，用来阻止旧数据被回填语句复活。
  "DELETE FROM recipe_catalog WHERE id IN (SELECT recipe_id FROM recipe_activity_log WHERE action = '删除菜谱' AND recipe_id IS NOT NULL)",
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

/** 预设门店目录入库。目录是全局的，目前只能通过改代码增加。 */
const SOURCE_SEEDS = FLYER_SOURCES.map(
  () =>
    `INSERT INTO flyer_sources (source_key, name, address, flyer_url, flyer_format, timezone)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_key) DO UPDATE SET name = excluded.name, address = excluded.address,
       flyer_url = excluded.flyer_url, flyer_format = excluded.flyer_format`,
);

/**
 * 多住户改造之前留下的表。数据已经迁进 household_stores 与 recipe_catalog，
 * 这里把它们真正删掉，让数据库结构和这个文件保持一致——留着不建也不删的幽灵表，
 * 「建表只有一个来源」这句话就不成立了。
 */
const DROPPED_TABLES = ["stores", "recipe_suggestions", "recipe_favorites"];

/**
 * 已经不该存在的列。
 *
 * 上面的 CREATE TABLE 改了只对新库生效——已经建好的表不会因此变形。
 * store_id 是 stores 表的遗留，多住户改造后所有查询都改用 source_key 了，
 * 可它在 flyer_deals 和 flyer_price_history 上还带着 NOT NULL，
 * 于是任何一个新建的数据库，Flyer 录入从第一条就插不进去。
 */
/**
 * 已经不该存在的索引。
 *
 * 从 INDEXES 里删掉一行只是以后不再建它，库里已有的那个不会消失。
 * 而 SQLite 不允许删除被索引引用的列——所以删列之前必须先删索引，顺序不能反。
 */
const DROPPED_INDEXES = [
  "idx_flyer_deals_store_source",
  "idx_flyer_price_history_item_store",
  // Replaced by idx_flyer_price_history_source. Keeping both wastes space and
  // the old definition used to run before source_key had been added on a new DB.
  "idx_flyer_price_history_item",
];

const DROPPED_COLUMNS: Array<{ table: string; column: string }> = [
  { table: "flyer_deals", column: "store_id" },
  { table: "flyer_price_history", column: "store_id" },
  { table: "flyer_recommendation_feedback", column: "store_id" },
];

export const ensureSchema = once(async () => {
  await env.DB.batch([...TABLES, ...INDEXES].map((ddl) => env.DB.prepare(ddl)));

  // 补列不放进 batch：backfill 需要看到刚加上的列，而 batch 是一个事务一次提交。
  for (const entry of await missingColumns()) {
    await env.DB.prepare(entry.ddl).run();
    if (entry.backfill) await env.DB.prepare(entry.backfill).run();
  }

  await env.DB.batch(INDEXES_ON_ADDED_COLUMNS.map((ddl) => env.DB.prepare(ddl)));
  await env.DB.batch(DROPPED_TABLES.map((table) => env.DB.prepare(`DROP TABLE IF EXISTS ${table}`)));

  await env.DB.batch(DROPPED_INDEXES.map((name) => env.DB.prepare(`DROP INDEX IF EXISTS ${name}`)));

  // 删列逐条来：表可能压根不存在，也可能列早就没了，任何一条失败都不该拖垮其余的。
  // 但失败的原因要记下来——之前这里是个空的 catch，删不掉时完全看不出为什么。
  for (const entry of DROPPED_COLUMNS) {
    try {
      await env.DB.prepare(`ALTER TABLE ${entry.table} DROP COLUMN ${entry.column}`).run();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // 列本来就不存在、表还没建，都是正常情况，不值得记。
      if (/no such column|no such table|duplicate column/i.test(reason)) continue;
      console.warn(
        JSON.stringify({
          at: new Date().toISOString(),
          scope: "schema",
          problem: "删列失败",
          table: entry.table,
          column: entry.column,
          reason,
        }),
      );
    }
  }

  await env.DB.batch([
    ...SOURCE_SEEDS.map((sql, index) =>
      env.DB.prepare(sql).bind(
        FLYER_SOURCES[index].sourceKey,
        FLYER_SOURCES[index].name,
        FLYER_SOURCES[index].address,
        FLYER_SOURCES[index].flyerUrl,
        FLYER_SOURCES[index].flyerFormat,
        FLYER_SOURCES[index].timeZone,
      ),
    ),
    ...SEEDS.map((sql) => env.DB.prepare(sql)),
  ]);
});
