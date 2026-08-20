import { env } from "cloudflare:workers";
import { once } from "../_shared/once";

/** 库存表由多个接口共同写入，建表和补列逻辑集中在这里。 */
export const ensureInventorySchema = once(async () => {
  await env.DB.prepare(
    `
    CREATE TABLE IF NOT EXISTS inventory_items (
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
    )
  `,
  ).run();

  const columns = await env.DB.prepare("PRAGMA table_info(inventory_items)").all<{ name: string }>();
  const has = (name: string) => columns.results.some((column) => column.name === name);

  if (!has("purchase_date")) {
    await env.DB.prepare("ALTER TABLE inventory_items ADD COLUMN purchase_date TEXT").run();
  }
  if (!has("remaining_percent")) {
    await env.DB.prepare(
      "ALTER TABLE inventory_items ADD COLUMN remaining_percent INTEGER NOT NULL DEFAULT 100",
    ).run();
    await env.DB.prepare(
      "UPDATE inventory_items SET remaining_percent = 0 WHERE quantity <= 0 OR level = '已用完'",
    ).run();
  }
  if (!has("opened_date")) {
    await env.DB.prepare("ALTER TABLE inventory_items ADD COLUMN opened_date TEXT").run();
  }
  if (!has("opened_shelf_life_days")) {
    await env.DB.prepare("ALTER TABLE inventory_items ADD COLUMN opened_shelf_life_days INTEGER").run();
  }

  await env.DB.prepare(
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
  ).run();
  await env.DB.batch([
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_purchase_records_date ON purchase_records(purchase_date)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_purchase_records_name ON purchase_records(name)"),
  ]);
});

export function defaultLocation(category: string) {
  if (["肉类海鲜", "乳品蛋类", "蔬菜水果"].includes(category)) return "冰箱";
  if (category === "冷冻食品") return "冷冻柜";
  if (["清洁用品", "洗护用品"].includes(category)) return "其他";
  return "厨房储物柜";
}
