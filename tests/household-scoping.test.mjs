import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

/**
 * 分库纪律的闸门。
 *
 * 每一条读写租户表的 SQL 都必须带上 household_id。这是将来能把数据按住户
 * 拆开的唯一前提，也是最容易在某次「临时查一下」时被破坏的约定。
 *
 * 改造期间这里是一个棘轮，未作用域的语句数从 111 逐批降到 0。
 * 现在已经归零，换成严格断言：一条都不许再出现。
 *
 * 见 docs/multi-household-design.md。
 */

const TENANT_TABLES = [
  "inventory_items",
  "inventory_attachments",
  "purchase_records",
  "household_settings",
  "household_members",
  "recipe_preferences",
  "recipe_catalog",
  "recipe_attachments",
  "recipe_cook_history",
  "recipe_ratings",
  "recipe_activity_log",
  "meal_requests",
  "shopping_items",
  "flyer_match_rules",
  "flyer_recommendation_feedback",
  "household_stores",
];

const API_DIR = new URL("../app/api/", import.meta.url);

async function collectSources(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) out.push(...(await collectSources(url)));
    else if (entry.name.endsWith(".ts"))
      out.push({ name: url.pathname.split("/api/")[1], code: await readFile(url, "utf8") });
  }
  return out;
}

/** 抽出 prepare() 里的 SQL 字面量，模板串和普通字符串都要。 */
function statements(code) {
  const found = [];
  const pattern = /\.prepare\(\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*")/g;
  for (const [, literal] of code.matchAll(pattern)) found.push(literal.slice(1, -1));
  return found;
}

async function unscoped() {
  const out = [];
  for (const file of await collectSources(API_DIR)) {
    // 建表模块负责定义结构与一次性迁移，本身不属于业务查询
    if (file.name.startsWith("_shared/schema")) continue;
    for (const sql of statements(file.code)) {
      const tables = TENANT_TABLES.filter((table) => new RegExp(`\\b${table}\\b`).test(sql));
      if (!tables.length || /household_id/.test(sql)) continue;
      out.push(`${file.name}: ${tables.join(", ")} — ${sql.replace(/\s+/g, " ").trim().slice(0, 70)}`);
    }
  }
  return out;
}

test("每一条读写租户表的查询都带 household_id", async () => {
  const found = await unscoped();
  assert.deepEqual(
    found,
    [],
    `跨住户的查询会让数据无法按住户拆开，也可能读到别人家的东西：\n${found.join("\n")}`,
  );
});

test("住户解析器只有一处实现", async () => {
  const sources = await collectSources(API_DIR);
  const owner = sources.find((file) => file.name === "_shared/household.ts");
  assert.ok(owner, "找不到 _shared/household.ts");
  assert.match(owner.code, /export async function resolveHousehold/);

  // 住户 id 不能在别处凭空构造，否则「接鉴权只改一个函数」这个前提就不成立。
  // 常量单独放在 householdId.ts：建表语句和解析器都要用它，而解析器依赖建表模块，
  // 放在任何一边都会形成循环引用。
  const offenders = sources
    .filter((file) => file.name !== "_shared/householdId.ts")
    .filter((file) => /["'`]household-default["'`]/.test(file.code))
    .map((file) => file.name);
  assert.deepEqual(offenders, [], `默认住户 id 只应出现在 _shared/householdId.ts：\n${offenders}`);
});

/**
 * 租户表的写入不能把 household_id 写成字面量。
 *
 * recipe_preferences 上就栽过：`VALUES (1, ?, ?, ?, ?)` 的第一列是 household_id，
 * 于是每个家的忌口设置都存进了一个谁也不读的住户 `1`。空库上它甚至不报错——
 * 存错地方然后返回成功，比直接失败更难发现。
 *
 * 已有的两条测试都抓不到：SQL 里确实出现了 household_id（作用域测试满意），
 * 占位符数量也和绑定对得上（绑定测试满意）。错的是那个位置放了常量。
 */
test("租户表的 household_id 必须来自绑定，不能是字面量", async () => {
  const offenders = [];
  for (const file of await collectSources(API_DIR)) {
    if (file.name.startsWith("_shared/schema")) continue; // 建表里的 DEFAULT 是另一回事
    for (const sql of statements(file.code)) {
      const insert = /INSERT(?:\s+OR\s+\w+)?\s+INTO\s+(\w+)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(sql);
      if (!insert) continue;
      const [, table, columnList, valueList] = insert;
      if (!TENANT_TABLES.includes(table)) continue;
      const columns = columnList.split(",").map((c) => c.trim());
      const values = valueList.split(",").map((v) => v.trim());
      const at = columns.indexOf("household_id");
      if (at === -1) continue;
      const bound = values[at];
      // 合法的只有 ? 或 ?1 这类编号占位符
      if (bound && !/^\?\d*$/.test(bound))
        offenders.push(`${file.name}: ${table} 的 household_id 写成了 ${bound}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `household_id 是常量的话，数据会静默写进别人的家：${"\n"}${offenders.join("\n")}`,
  );
});
