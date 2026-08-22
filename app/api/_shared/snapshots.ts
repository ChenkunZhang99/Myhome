import { env } from "cloudflare:workers";
import { exportHousehold } from "./dataTransfer";

/**
 * 自动备份。
 *
 * 快照存在 R2 里，键是 `backups/<住户>/<时间戳>.json`。用对象存储而不是
 * 数据库，是因为备份最该防的就是「数据库出了事」——把备份放进它要保护的
 * 那个东西里，等于没备份。
 *
 * 每个家只留最近若干份。备份的价值随时间迅速衰减，而无限增长的存储
 * 迟早要有人去清；与其等那一天，不如从第一天就自己滚动。
 */

const PREFIX = "backups";
/** 每 6 小时一次的话，14 份大约覆盖三天半。够回到「昨天还好好的」那个点。 */
const KEEP = 14;

function keyFor(householdId: string, at: Date) {
  return `${PREFIX}/${householdId}/${at.toISOString().replace(/[:.]/g, "-")}.json`;
}

/** 列出一个家的自动备份，新的在前。 */
export async function latestSnapshots(householdId: string) {
  const listed = await env.UPLOADS.list({ prefix: `${PREFIX}/${householdId}/` });
  return listed.objects
    .map((object) => ({
      key: object.key,
      size: object.size,
      at: object.uploaded.toISOString(),
    }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * 取一份备份的内容。
 *
 * 键必须落在这个家自己的前缀下——否则拼一个别人家的键就能读走别人的全部数据。
 */
export async function readSnapshot(householdId: string, key: string) {
  if (!key.startsWith(`${PREFIX}/${householdId}/`)) return null;
  const object = await env.UPLOADS.get(key);
  return object ? await object.text() : null;
}

/** 存一份快照，并把超出保留数量的旧的删掉。 */
export async function writeSnapshot(householdId: string) {
  const snapshot = await exportHousehold(householdId);
  const rows = Object.values(snapshot.tables).reduce((sum, table) => sum + table.length, 0);
  // 空家不值得占一个槽位，更不该把有内容的旧备份挤掉。
  if (rows === 0) return { skipped: true as const, rows };

  const key = keyFor(householdId, new Date());
  await env.UPLOADS.put(key, JSON.stringify(snapshot), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });

  const existing = await latestSnapshots(householdId);
  for (const stale of existing.slice(KEEP)) await env.UPLOADS.delete(stale.key);
  return { skipped: false as const, key, rows };
}

/** 所有有数据的住户。定时备份要逐个走一遍。 */
export async function householdsWithData() {
  const { results } = await env.DB.prepare(
    `SELECT household_id AS householdId FROM inventory_items
     UNION SELECT household_id FROM recipe_catalog
     UNION SELECT household_id FROM purchase_records`,
  ).all<{ householdId: string }>();
  return (results ?? []).map((row) => row.householdId);
}
