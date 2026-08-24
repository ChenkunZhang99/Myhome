import { env } from "cloudflare:workers";
import { UserFacingError } from "./observability";

/**
 * 一键导出与导入。
 *
 * 范围就是「租户表」——所有带 household_id 的表。这不是巧合：一个家的数据
 * 恰好就是这些表里属于它的那些行，多一张少一张都不对。所以清单和
 * tests/household-scoping.test.mjs 里那份是同一份，有测试盯着两边一致。
 *
 * 导出的是全局数据之外的一切：flyer 门店目录、优惠、价格历史不在其中，
 * 那些属于所有人，不属于某一家。
 *
 * 已知不包含：附件的字节。元数据（哪个文件、多大、什么类型）会导出，
 * 但图片本身在 R2 里，塞进 JSON 会让文件从几十 KB 涨到几十 MB。
 * 这是 v1 的取舍，写在这里以免被当成 bug。
 */

export const FORMAT = "home-stock-planner";
/** 中文规范值参与业务逻辑（分类、存放位置、库存等级），它们改名时靠这个号做映射。 */
export const VERSION = 1;

/** 导出范围。顺序即导入顺序——被引用的表排在前面。 */
export const EXPORTED_TABLES = [
  "household_settings",
  "household_members",
  "household_stores",
  "recipe_preferences",
  "inventory_items",
  "inventory_attachments",
  "purchase_records",
  "shopping_items",
  "recipe_catalog",
  "recipe_attachments",
  "recipe_cook_history",
  "recipe_ratings",
  "recipe_activity_log",
  "meal_requests",
  "flyer_match_rules",
  "flyer_recommendation_feedback",
] as const;

export type Snapshot = {
  format: string;
  version: number;
  exportedAt: string;
  tables: Record<string, Array<Record<string, unknown>>>;
};

type Column = { name: string; type: string; pk: number };

async function columnsOf(table: string) {
  const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<Column>();
  return results ?? [];
}

/**
 * 自增主键的列名。
 *
 * `id INTEGER PRIMARY KEY` 是 rowid 的别名，全库唯一——household_settings
 * 在第一个家里是 1，在第二个家里就得是 2。导入时保留原值会撞主键，
 * 所以这类列要丢掉，让 SQLite 自己分配。
 * 文本主键（UUID）则必须原样保留，否则表之间的引用会断。
 */
function autoIncrementKey(columns: Column[]) {
  const pk = columns.find((column) => column.pk === 1);
  return pk && pk.type.toUpperCase() === "INTEGER" ? pk.name : null;
}

export async function exportHousehold(householdId: string): Promise<Snapshot> {
  const tables: Snapshot["tables"] = {};
  for (const table of EXPORTED_TABLES) {
    const columns = await columnsOf(table);
    if (!columns.length) continue;
    const { results } = await env.DB.prepare(`SELECT * FROM ${table} WHERE household_id = ?`)
      .bind(householdId)
      .all<Record<string, unknown>>();
    const drop = new Set(["household_id", autoIncrementKey(columns)].filter(Boolean) as string[]);
    tables[table] = (results ?? []).map((row) =>
      Object.fromEntries(Object.entries(row).filter(([key]) => !drop.has(key))),
    );
  }
  return { format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), tables };
}

function assertSnapshot(value: unknown): Snapshot {
  const snapshot = value as Snapshot;
  if (!snapshot || typeof snapshot !== "object" || snapshot.format !== FORMAT)
    throw new UserFacingError("这个文件不是「家里有数」导出的备份");
  if (!Number.isInteger(snapshot.version) || snapshot.version > VERSION)
    throw new UserFacingError("这份备份来自更新的版本，请先升级应用再导入");
  if (!snapshot.tables || typeof snapshot.tables !== "object")
    throw new UserFacingError("备份文件的内容不完整");
  return snapshot;
}

/**
 * 写一批行。列以数据库当前的结构为准：
 * 备份里多出来的列忽略，少掉的列走默认值。这样老备份在新版本上仍然导得进去。
 */
async function insertRows(
  table: string,
  rows: Array<Record<string, unknown>>,
  householdId: string,
  freshIds: boolean,
) {
  if (!rows.length) return 0;
  const columns = await columnsOf(table);
  if (!columns.length) return 0;
  const known = new Set(columns.map((column) => column.name));
  const skip = autoIncrementKey(columns);
  const textPk = columns.find((column) => column.pk === 1 && column.type.toUpperCase() !== "INTEGER");

  const statements = rows.map((row) => {
    const entry: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row))
      if (known.has(key) && key !== skip && key !== "household_id") entry[key] = value;
    entry.household_id = householdId;
    // 合并导入时换新主键，避免和现有的行撞上。
    if (freshIds && textPk) entry[textPk.name] = crypto.randomUUID();

    const names = Object.keys(entry);
    return env.DB.prepare(
      `INSERT OR REPLACE INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
    ).bind(...names.map((name) => entry[name] as never));
  });

  // D1 的 batch 有大小上限，分片提交。
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
  return rows.length;
}

/**
 * 整份还原：先清空这个家的所有租户表，再按备份重建。
 *
 * 「先清空」是必须的——否则删掉的东西会在还原后复活，那就不叫还原了。
 */
export async function replaceHousehold(householdId: string, payload: unknown) {
  const snapshot = assertSnapshot(payload);
  const counts: Record<string, number> = {};
  // 反序删除：被引用的表最后清，虽然这里没有真正的外键约束，但顺序对得上更好读。
  for (const table of [...EXPORTED_TABLES].reverse())
    await env.DB.prepare(`DELETE FROM ${table} WHERE household_id = ?`).bind(householdId).run();
  for (const table of EXPORTED_TABLES) {
    const rows = snapshot.tables[table];
    if (Array.isArray(rows)) counts[table] = await insertRows(table, rows, householdId, false);
  }
  return counts;
}

/**
 * 把一个家的全部数据抹掉。
 *
 * 删的是这户在每一张租户表里的行——EXPORTED_TABLES 就是「一个家拥有什么」
 * 的定义，导出用它，注销也用它，两边不会各记一份而慢慢走散。
 *
 * R2 里的图片跟着一起删：那是这个家上传的字节，人走了还留着既是在计费，
 * 也仍然可以被 object key 直接取到。
 */
export async function purgeHousehold(householdId: string) {
  const attachments = await env.DB.prepare(
    `SELECT object_key AS objectKey FROM inventory_attachments WHERE household_id = ?1
     UNION SELECT object_key FROM recipe_attachments WHERE household_id = ?1`,
  )
    .bind(householdId)
    .all<{ objectKey: string }>();
  const keys = (attachments.results ?? []).map((row) => row.objectKey).filter(Boolean);
  // 先删字节再删记录：反过来的话记录没了，字节就成了没人知道的孤儿。
  if (keys.length) await env.UPLOADS.delete(keys);

  // 手工添加的门店有一条只属于这一户的来源，跟着一起清。必须赶在下面清空
  // household_stores 之前把它们捞出来，那之后就查不到了。
  // 预设门店和按邮编搜出来的是全局目录，别的家还在用，不能碰。
  const manual = await env.DB.prepare(
    "SELECT source_key AS sourceKey FROM household_stores WHERE household_id = ? AND source_key LIKE 'manual-%'",
  )
    .bind(householdId)
    .all<{ sourceKey: string }>();
  for (const { sourceKey } of manual.results ?? []) {
    await env.DB.batch([
      // 元数据先删：它靠 deal_id 指过来，优惠没了它就成了孤儿。
      env.DB.prepare(
        "DELETE FROM flyer_deal_metadata WHERE deal_id IN (SELECT id FROM flyer_deals WHERE source_key = ?)",
      ).bind(sourceKey),
      env.DB.prepare("DELETE FROM flyer_price_history WHERE source_key = ?").bind(sourceKey),
      env.DB.prepare("DELETE FROM flyer_deals WHERE source_key = ?").bind(sourceKey),
      env.DB.prepare("DELETE FROM flyer_sources WHERE source_key = ?").bind(sourceKey),
      env.DB.prepare("DELETE FROM flyer_source_areas WHERE source_key = ?").bind(sourceKey),
    ]);
  }

  for (const table of [...EXPORTED_TABLES].reverse())
    await env.DB.prepare(`DELETE FROM ${table} WHERE household_id = ?`).bind(householdId).run();

  await env.DB.batch([
    env.DB.prepare("DELETE FROM household_invites WHERE household_id = ?").bind(householdId),
    env.DB.prepare("DELETE FROM household_memberships WHERE household_id = ?").bind(householdId),
    env.DB.prepare("DELETE FROM households WHERE id = ?").bind(householdId),
    env.DB.prepare("DELETE FROM ai_quota WHERE household_id = ?").bind(householdId),
  ]);

  // 自动备份也要清掉，否则「我删了账号」之后 R2 里还躺着这个家的完整快照。
  const snapshots = await env.UPLOADS.list({ prefix: `backups/${householdId}/` });
  for (const object of snapshots.objects) await env.UPLOADS.delete(object.key);
}

/**
 * 合并导入：只收库存，其余表忽略。
 *
 * 为什么只收库存：跨表的记录彼此用 id 相互引用（评分指向菜谱、历史指向物品）。
 * 合并时要换主键，就得把所有引用一起改写，那是一层很容易出错的映射。
 * 而「从别处搬一批物品进来」这个真实需求只需要库存，所以先做对这一件事。
 */
export async function mergeInventory(householdId: string, payload: unknown) {
  const snapshot = assertSnapshot(payload);
  const rows = snapshot.tables.inventory_items;
  if (!Array.isArray(rows) || !rows.length) throw new UserFacingError("这份文件里没有可以导入的物品");
  return { inventory_items: await insertRows("inventory_items", rows, householdId, true) };
}
